.PHONY: test

test: node_modules/mocha
	./node_modules/.bin/mocha -u tdd

node_modules/mocha: node_modules/%:
	npm install $(@F)
