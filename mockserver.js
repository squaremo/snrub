var http = require('http');
var querystring = require('querystring');
var url = require('url');

var server = http.createServer(handle);

// mock out some path for testing subscriptions etc.
function handle(req, res) {
  var out = {}; out[req.method] = req.url;
  console.log(out);
  if (req.url == '/subscribeOK' && req.method == 'POST') {
    var chunks = [];
    req.setEncoding('utf8');
    req.on('data', function(d) {
      chunks.push(d);
    });
    req.on('end', function() {
      var params = querystring.parse(chunks.join(''));
      console.log({subscribe: params});
      res.statusCode = 202;
      res.end();
      sendSubscriptionVerification(params);
    });
  }


  else {
    res.statusCode = 404;
    res.end();
  }
}

function sendSubscriptionVerification(params) {
  // FIXME assumes no querystring
  var reqopts = url.parse(params['hub.callback']);
  qsobj = {
    'hub.mode': params['hub.mode'],
    'hub.topic': params['hub.topic'],
    'hub.challenge': "TRIPLE CHALLENGE!",
    'hub.lease_seconds': 3 * 24 * 60 * 60,
    'hub.verify_token': params['hub.verify_token']
  };
  reqopts.path += ('?' + querystring.stringify(qsobj));
  console.log({verifying: qsobj});
  http.get(reqopts, function(res) {
    res.on('data', function(d) {
      console.log({verify_response: {status: res.statusCode, data: d.toString()}});
    });
  });
}

server.listen(8000);
