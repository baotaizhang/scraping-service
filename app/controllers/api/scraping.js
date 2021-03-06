//
// Name:    scraping.js
// Purpose: Controller and routing for scraping (Account has Plans)
// Creator: Tom Söderlund
//

'use strict';

const express = require('express');
const _ = require('lodash');
const cheerio = require('cheerio');
const htmlMetadata = require('html-metadata');

const helpers = require('../../config/helpers');

const parseDOM = (domString, pageSel, complete, deep) => {

	// Use _ instead of . and $ instead of # to allow for easier JavaScript parsing
	const getElementReference = $element => ($element[0].name) + ($element.attr('class') ? '_'+$element.attr('class').replace(/ /g, '_') : '') + ($element.attr('id') ? '$'+$element.attr('id') : '');

	const traverseChildren = function (parentObj, obj, i, elem) {
		const $node = $(elem);
		const nodeRef = getElementReference($node);
		// Has children
		if ($node.children().length > 0) {
			obj[nodeRef] = obj[nodeRef] || {};
			// Has children AND text: use '.$text='
			if ($node.text().length > 0) {
				obj[nodeRef].$text = $node.text();
			}
			// Traverse the children
			$node.children().each(traverseChildren.bind(undefined, obj, obj[nodeRef]));
		}
		// Has only text
		else {
			obj[nodeRef] = $node.text();
		}
		// Delete parent.$text if same as this
		if ($node.text() === _.get(parentObj, '$text')) {
			delete parentObj.$text;
		}
	};

	const $ = cheerio.load(domString);
	const resultArray = $(pageSel).map(function (i, el) {
		// this === el
		if (complete) {
			// Complete DOM nodes
			return $(this).toString();
		}
		else if (deep) {
			// Deep objects
			let deepObj = {};
			traverseChildren(undefined, deepObj, undefined, this);
			return deepObj;
		}	
		else {
			// Shallow text
			return $(this).text();
		}
	}).get();
	return resultArray;
};

const scrapeChrome = function (req, res, next) {
	const pageUrl = decodeURIComponent(req.query.url);
	// Use $ instead of # to allow for easier URL parsing
	const pageSelector = decodeURIComponent(req.query.selector || 'body').replace(/\$/g, '#');
	const loadExtraTime = req.query.time || 0;
	const deepResults = req.query.deep || false;
	const completeResults = req.query.complete || false;
	const timeStart = Date.now();

	console.log(`Scrape: "${pageUrl}", "${pageSelector}", ${loadExtraTime} ms`);

	const CDP = require('chrome-remote-interface');
	CDP((client) => {
		// Extract used DevTools domains.
		const {Page, Runtime} = client;

		// Enable events on domains we are interested in.
		Promise.all([
			Page.enable()
		]).then(() => {
			return Page.navigate({ url: pageUrl });
		});

		// Evaluate outerHTML after page has loaded.
		Page.loadEventFired(() => {
			setTimeout(() => {
				Runtime.evaluate({ expression: 'document.body.outerHTML' }).then((result) => {
					const selectorsArray = pageSelector.split(',');
					const resultsObj = selectorsArray.map((sel) => {
						const resultArray = parseDOM(result.result.value, sel, completeResults, deepResults);
						return { selector: sel, count: resultArray.length, items: resultArray };
					});
					const timeFinish = Date.now();
					client.close();
					res.json({ time: (timeFinish-timeStart), results: resultsObj });
				});
			}, loadExtraTime); // extra time before accessing DOM
		});
	}).on('error', (err) => {
		console.error('Cannot connect to browser:', err);
		res.status(400).json({ error: err });
	});
};

const scrapeMetaData = function (req, res, next) {
	const pageUrl = decodeURIComponent(req.query.url);
	const protocol = _.includes(pageUrl, 'https:') ? 'https' : 'http';

	const returnResults = function (url, metadata) {
		const metadataAndUrl = _.merge({}, { url }, metadata);
		res.status(200).json(metadataAndUrl);
	};

	console.log(`Scrape metadata: "${pageUrl}"`);
	htmlMetadata(pageUrl)
		.then(returnResults.bind(undefined, pageUrl))
		.catch(function (getErr) {
			console.error(getErr);
			if (getErr.status === 504 && protocol === 'https') {
				// Change from HTTPS to HTTP
				const httpUrl = pageUrl.replace('https:', 'http:');
				htmlMetadata(httpUrl)
					.then(returnResults.bind(undefined, httpUrl))
					.catch(getErr2 => res.status(getErr2.status || 400).json(getErr2));
			}
			else {
				res.status(getErr.status || 400).json(getErr);
			}
		});
};

// Routes

module.exports = function (app, config) {

	const router = express.Router();
	app.use('/', router);

	router.get('/api/scrape', scrapeChrome);
	router.get('/api/meta', scrapeMetaData);

};