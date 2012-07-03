// -*- js-indent-level: 2 -*-
// Scheduler for polling URLs.

var util = require('util'),
    urlparse = require('url').parse;

var PROTOCOLS = {
  'http:': require('http'),
  'https:': require('https')
};

// Massive TODO: consider making this work like PuSH, that is, have
// leases (emit 'lease_expire' and expect a truthy value back), and
// callbacks per URL, and remove a callback if it errors (or returns a
// falsey value?).

function TimerScheduler(policy) {
  this._policy = policy || defaultPolicy();
  this._state = {};
}
util.inherits(TimerScheduler, require('events').EventEmitter);

exports.TimerScheduler = TimerScheduler;

(function(proto) {
  proto.register = function(url, options) {
    var that = this;
    this.state(
      url,
      function(_) {
        console.warn({warn: {reason: "Already polling", url: url}});
      },
      function() {
        var policy = that._policy.for(url),
            state = policy.initialState;
        state.status = 'running';
        state.request.headers = state.request.headers || {};
        for (k in options) {
          state[k] = options[k];
        }
        state.interval = state.baseInterval;
        that._setState(url, state, function(state) {
          that._poll(url);
        });
      });
  };

  proto._setState = function(url, state, callback) {
    this._state[url] = state;
    callback(state);
  }

  proto._allState = function(callback) {
    callback(this._state);
  }

  proto.start = function(callback) {
    var that = this;

    this._allState(function(states) {
      var now = +new Date();
      for (var url in states) {
        if (states.hasOwnProperty(url)) {
          var state = states[url];
          if (state.status !== 'stopped') {
            var last = state.lastResult || 0;
            var due = last + state.interval * 1000;
            console.warn("Restarting " + url);
            if (due < now) {
              // overdue
              that._poll(url);
            }
            else {
              var next = (due - now);
              that._pollAfterMillis(url, state, next);
            }
          }
        }
      }
    });
  }

  // Get the state, if any, of a particular URL. Call the second callback arg if there's no state.
  // Override to do something different.
  proto.state = function(url, callback, missingCallback) {
    (this._state[url]) ?
      callback(this._state[url]) :
      missingCallback && missingCallback();
  };

  // Actually try to fetch something. Trigger this when a scheduled
  // task comes up; probably doesn't need to be overridden.
  proto._poll = function(url) {
    var that = this;

    function ok(newState) {
      // reset any backoff
      newState.interval = newState.baseInterval;
      that._setState(url, newState, function() {
        that._schedule(url);
      });
    }

    function retry(newState, reason) {
      console.warn({error: {url: url, reason: reason}});
      newState.lastResult = {'error': {completed: +new Date,
                                       reason: reason}};
      that._setState(url, newState, function() {
        that._retryWithBackoff(url);
        that.emit('poll_error', url, newState.lastResult);
      });
    }

    function stop(newState, reason) {
      newState.status = 'stopped';
      newState.lastResult = {error: {completed: +new Date,
                                     reason: reason}};
      that._setState(url, newState, function() {
        that.emit('poll_error', url, newState.lastResult);
      });
    }

    this.state(url, function(state) {
      // In the case of a temporary redirect, we'll have a nextRequest
      // entry.
      var request;
      if (state.nextRequest) {
        request = state.nextRequest;
      }
      else {
        request = state.request;
        if (state.etag) {
          request.headers['If-None-Match'] = state.etag;
        }
        if (state.lastModified) {
          request.headers['If-Modified-Since'] = state.lastModified;
        }
      }
      delete state.nextRequest;

      // Using a request object may mutate it; and in particular, may
      // mutate it into a cyclical structure. As a hack, we make sure
      // it doesn't have the bit that could be circular. Better might
      // be to create a fresh request.

      var req = PROTOCOLS[request.protocol].get(request, function(res) {
        delete request.agent;
        var status = res.statusCode;

        // be optimistic
        if (status === 200) {
          var fullSize = res.headers['content-length'] &&
            parseInt(res.headers['content-length']);
          var size = 0;
          var chunks = [];
          res.on('data', function(d) { chunks.push(d); size += d.length; });
          res.on('end', function() {
            if (!fullSize || size == fullSize) {
              state.lastResult = {'ok': {completed: +new Date,
                                         sizeInBytes: fullSize}};
              // get etags and/or last-modified
              // TODO do I want to do this if using nextRequest?
              if (res.headers['etag']) {
                state.etag = res.headers['etag'];
              }
              if (res.headers['last-modified']) {
                state.request.headers = state.request.headers || {};
                state.lastModified = res.headers['last-modified'];
              }

              ok(state);
              // %%%FIXME Perhaps not most efficient. Benchmark? Also,
              // do I really want to assume utf8, or just forward
              // bytes. Probably bytes.
              var result = '';
              chunks.forEach(function(chunk) { result += chunk.toString('utf8'); });
              that.emit('update', url, result, res.headers);
            }
            else {
              retry(state, "Bytes recvd (" + size + ") < Content-Length header (" + res.headers['content-length'] + ")");
            }
          });
        }

        else if (status === 304) { // not modified
          state.lastResult = {not_modified: {completed: +new Date}};
          ok(state);
        }

        else if (status === 404) {
          // Um. Backoff and retry
          retry(state, "Document not found");
        }

        else if (status === 401) { // Unauthorised. Requires special consideration.
          // FIXME
          stop(state, "Unauthorised");
        }
        //else if (status === 407) { // similar to 401; proxy auth required
          // Unclear if this should be supported.
        //}
        else if (status === 403) { // Nope nope nope.
          stop(state, "Forbidden");
        }
        else if (status === 410) { // Gone! Do not reschedule. It's not coming back.
          stop(state, "Document gone");
        }
        else if (status >= 400 && status < 500) {
          // Any number of problems we don't expect to have
          stop(state, "Unexpected response " + status);
        }

        else if (status === 301) { // moved permanently; update URL
          var location = res.headers['location'];
          if (location) {
            state.lastResult = {redirect: {location: location,
                                           completed: +new Date}};
            state.request = urlparse(location);
            that._setState(url, state, function() {
              // %%% FIXME detect cycles / avoid infinite redirects
              that.register(location, state);
            });
          }
          else {
            retry(state, "Redirect without location header");
          }
        }

        else if (status === 302 || status === 303 || status === 307) {
          // temporary redirect
          var location = res.headers['location'];
          if (location) {
            state.lastResult = {redirect: {location: location,
                                           completed: +new Date}};
            state.nextRequest = urlparse(location);
            that._setState(url, state, function() {
              // %%% FIXME detect cycles / avoid infinite redirects
              that._poll(url);
            });
          }
          else {
            retry(state, "Redirect without location header");
          }
        }

        else if (status >= 500) {
          retry(state, "Server error " + status);
        }

      });
      req.on('error', function() {
        retry(state, "Connection error");
      });
    });
  };

  // Lost in a maze of twisty continuations.
  // (probably I can separate things into stuff that needs to fetch
  // the state, and stuff that can go ahead right now.)

  proto._schedule = function(url) {
    var that = this;
    this.state(url, function(state) {
      that._pollAfterMillis(url, state, state.interval * 1000);
    });
  };

  proto._pollAfterMillis = function(url, state, millis) {
    //state.timer = setTimeout(function() { that._poll(url); },
    //                         state.interval * 1000);
    // FIXME Umm, race condition at all?
    // TODO: What should the continuation do, if anything?
    this._setState(url, state, function() {});
  }

  proto._retryWithBackoff = function(url) {
    var that = this;
    this.state(url, function(state) {
      var retryInterval = state.backoffMultiplier * state.interval;
      if (retryInterval > (state.interval * state.backoffLimit)) {
        state.status = 'stopped';
        state.lastResult = {error: {reason: "Retries exceeded"}};
        that._setState(url, state, function() {
          that.emit('error', url, state.lastResult);
        });
      }
      else {
        state.interval = retryInterval;
        that._setState(url, state, function() {
          that._schedule(url);
        });
      }
    });
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
          backoffLimit: 8,
          lastResult: null,
          request: opts
        },
      }
    }
  };
}
