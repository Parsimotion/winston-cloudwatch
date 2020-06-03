'use strict';

var util = require('util'),
    winston = require('winston'),
    AWS = require('aws-sdk'),
    cloudWatchIntegration = require('./lib/cloudwatch-integration'),
    isEmpty = require('lodash.isempty'),
    assign = require('lodash.assign'),
    isError = require('lodash.iserror'),
    stringify = require('./lib/utils').stringify,
    debug = require('./lib/utils').debug,
    defaultFlushTimeoutMs = 10000;

var WinstonCloudWatch = function(options) {
  winston.Transport.call(this, options);
  this.level = options.level || 'info';
  this.name = options.name || 'CloudWatch';
  this.logGroupName = options.logGroupName;
  this.retentionInDays = options.retentionInDays || 0;
  this.logStreamName = options.logStreamName;

  var awsAccessKeyId = options.awsAccessKeyId;
  var awsSecretKey = options.awsSecretKey;
  var awsRegion = options.awsRegion;
  var messageFormatter = options.messageFormatter ? options.messageFormatter : function(log) {
    return [ log.level, log.message ].join(' - ')
  };
  this.formatMessage = options.jsonMessage ? stringify : messageFormatter;
  this.proxyServer = options.proxyServer;
  this.uploadRate = options.uploadRate || 2000;
  this.logEvents = [];
  this.errorHandler = options.errorHandler;

  if (options.cloudWatchLogs) {
    this.cloudwatchlogs = options.cloudWatchLogs;
  } else {
    if (this.proxyServer) {
      AWS.config.update({
        httpOptions: {
          agent: require('proxy-agent')(this.proxyServer)
        }
      });
    }

    var config = {};

    if (awsAccessKeyId && awsSecretKey && awsRegion) {
      config = { accessKeyId: awsAccessKeyId, secretAccessKey: awsSecretKey, region: awsRegion };
    } else if (awsRegion && !awsAccessKeyId && !awsSecretKey) {
      // Amazon SDK will automatically pull access credentials
      // from IAM Role when running on EC2 but region still
      // needs to be configured
      config = { region: awsRegion };
    }

    if (options.awsOptions) {
      config = assign(config, options.awsOptions);
    }

    this.cloudwatchlogs = new AWS.CloudWatchLogs(config);
  }

  debug('constructor finished');
};

util.inherits(WinstonCloudWatch, winston.Transport);

WinstonCloudWatch.prototype.log = function (info, callback) {
  debug('log (called by winston)', info);

  if (!isEmpty(info.message) || isError(info.message)) { 
    this.add(info);
  }

  if (!/^uncaughtException: /.test(info.message)) {
    // do not wait, just return right away
    return callback(null, true);
  }

  debug('message not empty, proceeding')

  // clear interval and send logs immediately
  // as Winston is about to end the process
  clearInterval(this.intervalId);
  this.intervalId = null;
  this.submit(callback);
};

WinstonCloudWatch.prototype.add = function(log) {
  debug('add log to queue', log);

  var self = this;

  if (!isEmpty(log.message) || isError(log.message)) {
    self.logEvents.push({
      rawMessage: log,
      message: self.formatMessage(log),
      timestamp: new Date().getTime()
    });
  }

  if (!self.intervalId) {
    debug('creating interval');
    self.intervalId = setInterval(function() {
      self.submit(function(err) {
        if (err) {
          debug('error during submit', err, true);
          self.errorHandler ? self.errorHandler(err) : console.error(err);
        }
      });
    }, self.uploadRate);
  }
};

WinstonCloudWatch.prototype.submit = function(callback) {
  var groupNameGetter = typeof this.logGroupName === 'function' ?
    this.logGroupName : _.constant(this.logGroupName);
  var streamNameGetter = typeof this.logStreamName === 'function' ?
    this.logStreamName : _.constant(this.logStreamName);
  var retentionInDays = this.retentionInDays;

  if (isEmpty(this.logEvents)) {
    return callback();
  }

  _(this.logEvents)
  .groupBy(({ rawMessage }) => `${groupNameGetter(rawMessage)}_${streamNameGetter(rawMessage)}`)
  .map((events, destination) => {
    const groupName = groupNameGetter(events[0].rawMessage);
    const streamName = streamNameGetter(events[0].rawMessage);
    cloudWatchIntegration.upload(
      this.cloudwatchlogs,
      groupName,
      streamName,
      events.map(it => _.omit(it, "rawMessage")),
      retentionInDays,
      callback
    );
  })
  .value()

};

WinstonCloudWatch.prototype.kthxbye = function(callback) {  
  clearInterval(this.intervalId);
  this.intervalId = null;
  this.flushTimeout = this.flushTimeout || (Date.now() + defaultFlushTimeoutMs);

  this.submit((function(error) {    
    if (error) return callback(error);
    if (isEmpty(this.logEvents)) return callback();
    if (Date.now() > this.flushTimeout) return callback(new Error('Timeout reached while waiting for logs to submit'));
    else setTimeout(this.kthxbye.bind(this, callback), 0);
  }).bind(this));
};

winston.transports.CloudWatch = WinstonCloudWatch;

module.exports = WinstonCloudWatch;
