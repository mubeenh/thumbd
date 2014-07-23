var aws = require('aws-sdk'),
	_ = require('underscore'),
	config = require('./config').Config,
	Grabber = require('./grabber').Grabber,
	Thumbnailer = require('./thumbnailer').Thumbnailer,
	Saver = require('./saver').Saver,
	fs = require('fs'),
	request = require('request'),
	async = require('async'),
	knox = require('knox');

/**
 * Initialize the Worker
 *
 * @param object opts Worker configuration. Optional.
 */
function Worker(opts) {
	_.extend(this, {
		thumbnailer: null,
		grabber: null,
		saver: null
	}, opts);

	this.sqs = new aws.SQS({
		accessKeyId: config.get('awsKey'),
		secretAccessKey: config.get('awsSecret'),
		region: config.get('awsRegion')
	});

	config.set('sqsQueueUrl', this.sqs.endpoint.protocol + '//' + this.sqs.endpoint.hostname + '/' + config.get('sqsQueue'));
}

/**
 * Start the worker
 */
Worker.prototype.start = function() {
	this._processSQSMessage();
};

/**
 * Process the next message in the queue
 */
Worker.prototype._processSQSMessage = function() {
	var _this = this;

	console.log('wait for message on ' + config.get('sqsQueue'));

	this.sqs.receiveMessage( { QueueUrl: config.get('sqsQueueUrl'), MaxNumberOfMessages: 1 }, function (err, job) {
		if (err) {
			console.log(err);
			_this._processSQSMessage();
			return;
		}

		if (!job.Messages || job.Messages.length === 0) {
			_this._processSQSMessage();
			return;
		}

		// Handle the message we pulled off the queue.
		var handle = job.Messages[0].ReceiptHandle,
			body = null;

		try { // a JSON string message body is accepted.
			body = JSON.parse( job.Messages[0].Body );
		} catch(e) {
			if (e instanceof SyntaxError) {
				// a Base64 encoded JSON string message body is also accepted.
				body = JSON.parse( new Buffer(job.Messages[0].Body, 'base64').toString( 'binary' ) );
			} else {
				// TODO: figure out if throwing is actually
				// the right thing to do here.
				throw e;
			}
		}

		_this._runJob(handle, body, function() {
			_this._processSQSMessage();
		});
	});
};

/**
 * Process a job from the queue
 *
 * @param string handle The SQS message handle
 * @param object job The job parameters
 * @param function callback The callback function
 */
Worker.prototype._runJob = function(handle, job, callback) {
	/**
		job = {
			"original": "/foo/awesome.jpg",
			// OR:
			"resources": [
			// List of resources to download
			],
			"prefix": "/foo/awesome",
			"descriptions": [{
				"suffix": "small",
				"width": 64,
				"height": 64
			}],
		}
	*/

	var bucket = job.bucket;

	// handle legacy, 'original' key vs. 'resources'.
	if (job.original) job.resources = [job.original];

	var _this = this;

	async.waterfall([
		function(done) {
			async.mapLimit(job.resources, 5, function(resource, done) {
				_this._downloadFromS3(resource, done);
			}, done);
		},
		function(localPaths, done) {
			_this._createThumbnails(localPaths, job, function(err, uploadedFiles) {
				async.forEach(localPaths, fs.unlink, function(errUnlink) {
					if (errUnlink) {
						console.log("WARNING: failed to delete temporary file " + errUnlink.path);
					}
					done(err, uploadedFiles);
				});
			});
		},
		function(uploadedFiles, done) {
			job.output = uploadedFiles;
			_this._notify(job, done);
		}
	], function(err) {
		if (!err) {
			_this._deleteJob(handle);
		}
		callback();
	});
};

/**
 * Download the image from S3
 *
 * @param string remoteImagePath The s3 path to the image
 * @param function callback The callback function
 */
Worker.prototype._downloadFromS3 = function(bucket, remoteImagePath, callback) {
	var s3 = this._createKnoxClientForBucket(bucket);
	var grabber = require('./grabber').Grabber(s3);
	grabber.download(remoteImagePath, function(err, localPath) {
		// Leave the job in the queue if an error occurs.
		if (err) {
			callback(err);
			return;
		}

		callback(null, localPath);
	});
};

/**
 * Create thumbnails for the image
 *
 * @param string localPath The local path to store the images
 * @param object job The job description
 * @param function callback The callback function
 */
Worker.prototype._createThumbnails = function(localPaths, job, callback) {

	var _this = this,
		work = [];

	// Create thumbnailing work for each thumbnail description.
	job.descriptions.forEach(function(description) {
		work.push(function(done) {

			var remoteImagePath = _this._thumbnailKey(job.prefix, description.suffix, description.format),
				thumbnailer = new Thumbnailer();

			thumbnailer.execute(description, localPaths, function(err, convertedImagePath) {

				if (err) {
					console.log(err);
					done();
				} else {
					_this._saveThumbnailToS3(bucket, convertedImagePath, remoteImagePath, function(err) {
						if (err) console.log(err);
						done(null, remoteImagePath);
					});
				}

			});

		});
	});

	// perform thumbnailing in parallel.
	async.parallel(work, callback);
};

/**
 * Save the thumbnail to S3
 *
 * @param string convertedImagePath The local path to the image
 * @param string remoteImagePath The S3 path for the image
 * @param function callback The callback function
 */
Worker.prototype._saveThumbnailToS3 = function(bucket, convertedImagePath, remoteImagePath, callback) {
	var s3 = this._createKnoxClientForBucket(bucket);
	var saver = require('./saver').Saver(s3);
	saver.save(convertedImagePath, remoteImagePath, function(err) {
		fs.unlink(convertedImagePath, function() {
			callback(err);
		});
	});
};

/**
 * Generate a path for this thumbnail
 *
 * @param string original The original image path
 * @param string suffix The thumbnail suffix. e.g. "small"
 * @param string format The thumbnail format. e.g. "jpg". Optional.
 */
Worker.prototype._thumbnailKey = function(prefix, suffix, format) {
	return prefix + '_' + suffix + '.' + (format || 'jpg');
};

/**
 * Remove a job from the queue
 *
 * @param string handle The SQS message handle
 */
Worker.prototype._deleteJob = function(handle) {
	this.sqs.deleteMessage({QueueUrl: config.get('sqsQueueUrl'), ReceiptHandle: handle}, function(err, resp) {
		if (err) {
			console.log("error deleting thumbnail job " + handle, err);
			return;
		}
		console.log('deleted thumbnail job ' + handle);
	});
};

Worker.prototype._createKnoxClientForBucket = function (bucket) {
	return knox.createClient({
		key: config.get('awsKey'),
		secret: config.get('awsSecret'),
		bucket: bucket || config.get('s3Bucket')
	});
};

/**
 * Call notification url
 *
 * @param string job: the body of the SQS job.
 */
Worker.prototype._notify = function(job, cb) {
  if (!job.notify) return cb();

	var options = {
		method: "POST",
		url: job.notify,
		json: true,
		body: job
	}

	request.post(options, function(err) {
		if (!err) {
			console.log('notified:', job.notify);
		}
		return cb();
	});
}

exports.Worker = Worker;
