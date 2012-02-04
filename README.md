# PuSH subscriber as Connect middleware

This module provides a [PuSH
(pubsubhubbub)](http://pubsubhubbub.appspot.com) subscriber. This is a
object with methods for subscribing to, and unsubscribing from, topics
on PuSH hubs.

The object gives you a middleware you can use with
[Connect](http://www.senchalabs.org/connect/connect.html) or
[Express](http://expressjs.com/guide.html); provided you host it
somewhere suitably accessible via HTTP, it will then accept HTTP
updates from the hubs and emit them as events.

    var subscriber = require('snrub')
      .createSubscriber({'host': 'example.com:8000'});
    var app = connect(subscriber.middleware());

    subscriber.subscribe('http://pubsubhubbub.appspot.com', // hub
                         'http://blog.cloudfoundry.com/feed');
    subscriber.on('subscribe', function(topic) {
      console.log("Subscribed to " + topic;)
    });
    subscriber.on('update', function(topic, content) {
      console.log("Content from " + topic);
      console.log(content);
    });

    app.listen(8000); // pretending we are on host example.com

A demo is available at http://snrub-demo.cloudfoundry.com/.
