// Removing duplicates from a feed.

// The PuSH subscriber and the HTTP polling yield raw data as 'update'
// events. Assuming these are feeds of some kind (RSS, Atom, ..), but
// not necessarily monotonic (i.e., even if a feed document has
// changed, we may get an overlapping set of entries), we will want to
// remove duplicate entries. To do this we need to be able to:
//
//  - split a feed into individual entries
//  - assign each entry a canonical identifier
//  - know if we have seen the entry with a particular identifier before.
//
// Atom provides for this with each entry having an `id` element;
// however, it identifies the entry without regard to time, that is,
// an updated entry will have the same id. Whether we regard this as
// new or not will depend on policy. RSS 2.0 similarly provides
// `guid`. Otherwise we may use a hash of the content, or some
// combination of the updated time and a guide or id.
//
// To determine whether we have seen an entry before, of course we
// need a record of those we have seen. But we cannot keep these
// indefinitely, so we use a moving window. The question is: how long
// can we expect an entry to be current? This will depend on the
// particular feed; but as an heuristic we can reasonably expect that,
// if a poll gives an earliest entry of T, that the record of entries
// from that feed prior to T can be flushed.

function Dedup() {
  this._topics = {};
}

exports.create = function() {
  return new Dedup();
};

(function(proto) {

  // take a list of {'timestamp': _, 'id': _, 'data': _} and return
  // those that are new.
  proto.newEntries = function(topic, entries) {
    var topicSet = this._topicSet(topic);
    var earliest = Number.MAX_VALUE;
    var newer = [];
    entries.forEach(function(entry) {
      if (entry.timestamp < earliest) {
        earliest = entry.timestamp;
      }
      if (!topicSet.includes(entry.id)) {
        topicSet.add(entry.id, entry, entry.timestamp);
        newer.push(entry);
      }
    });
    topicSet.removeLessThan(earliest);
    return newer;
  };

  // return all the entries in the window
  proto.allEntries = function(topic) {
    var set = this._topicSet(topic);
    return set.all();
  }

  proto._topicSet = function(topic) {
    var set;
    if (set = this._topics[topic]) {
      return set;
    }
    else {
      this._topics[topic] = set = new PrioritySet();
      return set;
    }
  }

})(Dedup.prototype);

// Totally noddy implementation of a set in which things can be
// 'expired'. The data must be strings; the scores just have to be
// comparable.
function PrioritySet() {
  this._set = {};
}
(function(proto) {

  function Item(datum, score) {
    this.score = score;
    this.datum = datum;
  }

  proto.add = function(id, datum, score) {
    this._set[id] = new Item(datum, score);
    return this;
  }

  proto.includes = function(id) {
    return this._set[id];
  }

  proto.removeLessThan = function(score) {
    var set = this._set;
    for (var k in set) {
      if (set[k].score < score) {
        delete set[k];
      }
    }
  }

  proto.all = function() {
    var items = [];
    var set = this._set;
    for (var k in set) {
      items.push(set[k]);
    }
    items.sort(function(a, b) { return a.score - b.score; });
    for (var i in items) {
      items[i] = items[i].datum;
    }
    return items;
  }

})(PrioritySet.prototype);
