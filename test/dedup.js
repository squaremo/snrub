var dedup = require('../index').dedup;
var assert = require('assert');

function testset() {
  return [
    {'timestamp': 1, 'id': '1', 'datum': 'foobar'},
    {'timestamp': 2, 'id': '2', 'datum': 'barfoo'},
    {'timestamp': 3, 'id': '3', 'datum': 'foobaz'}
  ];
}

suite("Default deduplicater", function() {
  test("All new entries", function() {
    var dd = dedup();
    var es = testset();
    assert.deepEqual(es, dd.newEntries("topic", es));
    assert.deepEqual([], dd.newEntries("topic", es));
  });

  test("Different topics", function() {
    var dd = dedup();
    var es = testset();
    assert.deepEqual(es, dd.newEntries("topic1", es));
    assert.deepEqual(es, dd.newEntries("topic2", es));
  });

  test("Overlapping", function() {
    var dd = dedup();
    var e12 = testset().slice(0, 2);
    var e23 = testset().slice(1, 3);
    var e3 = testset().slice(2);
    assert.deepEqual(e12, dd.newEntries("topic", e12));
    assert.deepEqual(e3, dd.newEntries("topic", e23));
  });
});
