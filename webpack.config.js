const path = require('path');

module.exports = {
	entry: './index.js',
	output: {
		filename: 'browser.js',
		path: path.resolve(__dirname),
		library: 'tribeone',
		libraryTarget: 'umd',
	},
	resolve: {
		fallback: { assert: false, stream: false },
	},
};
