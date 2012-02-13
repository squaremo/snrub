// Scheduler for polling URLs.

var util = require('util'),
  urlparse = require('url').parse;

var PROTOCOLS = {
  'http:': require('http'),
  'https:': require('https')
};

function TimerScheduler(policy) {
  this._policy = policy || defaultPolicy();
  this._state = {};
}
util.inherits(TimerScheduler, require('events').EventEmitter);

exports.TimerScheduler = TimerScheduler;

(function(proto) {
  // TODO Probably need to make this take a callback
  proto.register = function(url, options) {
    if (!this._state[url]) {
      var policy = this._policy.for(url),
        state = policy.initialState;
      for (k in options) {
        state[k] = options[k];
      }
      state.interval = state.baseInterval;
      this._state[url] = state;
      this._poll(url);
    }
  };

  proto._setState = function(url, state) {
    this._state[url] = state;
  }

  proto._poll = function(url) {
    var that = this;
    var state = this.state(url);
    // In the case of a temporary redirect, we'll have a nextRequest
    // entry.
    var request = state.nextRequest || state.request;
    delete state.nextRequest;
    var req = PROTOCOLS[request.protocol].get(request, function(res) {
      var status = res.statusCode;
      // be optimistic
      if (status === 200) {
        var fullSize = parseInt(res.headers['content-length']);
        var size = 0;
        var chunks = [];
        res.on('data', function(d) { chunks.push(d); size += d.length; });
        res.on('end', function() {
          if (size == fullSize) {
            state.lastResult = {'ok': {completed: +new Date,
                                       sizeInBytes: fullSize}};
            // reset any backoff
            state.interval = state.baseInterval;
            that._setState(url, state);
            that._schedule(url);
            // %%%FIXME Perhaps not most efficient. Benchmark? Also,
            // do I really want to assume utf8, or just forward
            // bytes. Probably bytes.
            var result = '';
            chunks.forEach(function(chunk) { result += chunk.toString('utf8'); });
            that.emit('update', url, result, res.headers['content-type']);
          }
          else {
            console.warn({expected: fullSize, got: size, headers: res.headers});
            state.lastResult = {'error': {completed: +new Date,
                                          reason: "Connection interrupted"}};
            that._setState(url, state);
            that._retryWithBackoff(url);
            that.emit('poll_error', url, state.lastResult);
          }
        });
      }
      else if (status === 404) {
        // Um. Backoff and retry
        state.lastResult = {error: {completed: +new Date,
                                    reason: "Document not found"}};
        that._setState(url, state);
        that._retryWithBackoff(url);
        that.emit('poll_error', url, state.lastResult);
      }
      else if (status === 401) { // Unauthorised. Requires special consideration.
        
      }
      else if (status === 403) { // Nope nope nope.
      }
      else if (status === 410) { // Gone! Do not reschedule. It's not coming back.
        state.lastResult = {error: {completed: +new Date,
                                    reason: "Document gone"}};
        that._setState(url, state);
        that.emit('poll_error', url, state.lastResult);
      }
      else if (status >= 400 && status < 500) {
        // Any number of problems we don't expect to have
        
      }
      else if (status === 301) { // moved permanently; update URL
        var location = res.headers['Location'];
        if (location) {
          state.lastResult = {redirect: {location: location,
                                         completed: +new Date}};
          state.request = urlparse(location);
          that._setState(url, state);
          // %%% FIXME detect cycles / avoid infinite redirects
          that.register(location, state);
        }
        else {
          state.lastResult = {error: {completed: +new Date,
                                      reason: "Redirect without location header"}};
          that._setState(url, state);
          that._retryWithBackoff(url);
          that.emit('poll_error', url, state.lastResult);
        }
      }
      else if (status === 302 || status === 303 || status === 307) {
        // temporary redirect
        var location = res.headers['Location'];
        if (location) {
          state.lastResult = {redirect: {location: location,
                                         completed: +new Date}};
          state.nextRequest = urlparse(location);
          that._setState(url, state);
          // %%% FIXME detect cycles / avoid infinite redirects
          that._poll(url);
        }
        else {
          state.lastResult = {error: {complete: +new Date,
                                      reason: "Redirect without location header"}};
          that._setState(url, state);
          that._retryWithBackoff(url);
          that.emit('poll_error', url, state.lastResult);
        }
      }
      else if (status >= 500) {
        state.lastResult = {error: {complete: +new Date,
                                    reason: "Server error " + status}};
        that._setState(url, state);
        that._retryWithBackoff(url);
        that.emit('poll_error', url, state.lastResult);
      }
    });
    req.on('error', function() {
      state.lastResult = {error: {complete: +new Date,
                                  reason: "Connection error"}};
      that._setState(url, state);
      that._retryWithBackoff(url);
      that.emit('poll_error', url, state.lastResult);
    });
  };

  proto._schedule = function(url) {
    var that = this;
    var state = this.state(url);
    setTimeout(function() { that._poll(url)},
               state.interval * 1000);
  };

  proto._retryWithBackoff = function(url) {
    var state = this.state(url);
    var retryInterval = state.backoffMultiplier * state.interval;
    if (retryInterval > state.backoffLimit) {
      state.lastResult = {stopped: {reason: "Retries exceeded"}};
      this._setState(url, state);
      this.emit('error', url, state.lastResult);
    }
    else {
      state.interval = retryInterval;
      this._setState(url, state);
      this._schedule(url);
    }
  };

  // Get the state, if any, of a particular URL
  proto.state = function(url) {
    return this._state[url];
  };

})(TimerScheduler.prototype);

function defaultPolicy() {
  return {
    'for': function(url) {
      var opts = urlparse(url);
      return {
        initialState: {
          baseInterval: 10 * 60,
          interval: 10 * 60,
          backoffMultiplier: 2,
          backoffLimit: 8 * 10 * 60,
          lastResult: null,
          request: opts
        },
      }
    }
  };
}
