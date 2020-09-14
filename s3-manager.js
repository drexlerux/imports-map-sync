/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-undef */
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');
require('dotenv').config();

const fileConfigPath = path.resolve('config.json');

const TEMPLATE = 'template';
const LOCAL = 'local';
const LOCALHOST = 'localhost';
const MICROTIME_ZERO = '000000';

class S3Manager {
	constructor(type = 'root') {
		this.type = type;
		this.microtime = Date.now();
		this.options = { importMapsPath: '' };
		this.s3 = new AWS.S3();
		this.checkEnvs(process.env, [
			'APP_ALIAS',
			'CONFIG_BUCKET',
			'PORT',
			'MODE',
			'INDEX',
			'LOCAL_ORIGIN?',
		]);

		this.LOCAL_ORIGIN = this.LOCAL_ORIGIN || 'http://localhost';

		if (this.MODE === LOCAL) {
			this.BRANCH = LOCALHOST;
		} else {
			this.checkEnvs(process.env, ['BRANCH']);
			this.options = this.importMapsPath();
		}
	}

	/**
	 *
	 * @method launch()
	 * @description deployment launcher
	 * @returns {Promise}
	 */
	launch() {
		const port = this.LOCAL_ORIGIN.endsWith(LOCALHOST) ? `:${this.PORT}` : '';
		const synceds = [
			{
				prefix: TEMPLATE,
				pathLocation: `${this.LOCAL_ORIGIN}${port}/${this.getRelativePath()}`,
				checker: (prefix, cb) => cb(true),
			},
		];

		if (this.MODE !== 'local') {
			synceds.push({
				prefix: this.BRANCH,
				pathLocation: `${this.options.origin}/${this.getRelativePath(
					this.microtime
				)}`,
				checker: (prefix, cb) => this.checkFile(prefix, cb),
			});
		}

		const promises = [];

		synceds.forEach(({ prefix, pathLocation, checker }) => {
			checker(prefix, (exists) => {
				const newPrefix = exists === false ? TEMPLATE : prefix;
				promises.push(
					this.importMapsContent(newPrefix).then((data) => {
						const { jsonParseData } = data;
						jsonParseData.imports[this.APP_ALIAS] = pathLocation;
						this.sortImports(jsonParseData);
						return this.upload({ prefix, body: jsonParseData }).then(
							() => data
						);
					})
				);
			});
		});

		return Promise.all(promises);
	}

	/**
	 *
	 * @method checkEnvs()
	 * @description check and validate enviroment variables
	 * @param {object} enviroment
	 * @param {array} requiredEnvs
	 * @returns {void}
	 */
	checkEnvs(enviroment, requiredEnvs) {
		for (let env of requiredEnvs) {
			if (!(env in enviroment) && !env.endsWith('?')) {
				throw new Error(`The enviroment variable ${env} is required`);
			}

			env = env.replace('?', '');
			this[env] = enviroment[env];
		}
	}

	/**
	 *
	 * @method importMapsPath()
	 * @description return full path for importmaps.json file
	 * @returns {string} importmaps.json full path
	 */
	importMapsPath() {
		const { origin, pathname } = new URL(
			this.s3.getSignedUrl('getObject', this.getParams({})).toString()
		);
		return { importMapsPath: `${origin}${pathname}`, origin };
	}

	/**
	 *
	 * @method appFolder()
	 * @description return snack-case for use as app folder then make the deploy
	 * @returns {string} @company/app -> company-app
	 */
	appFolder() {
		return this.APP_ALIAS.replace('@', '').replace('/', '-');
	}

	/**
	 *
	 * @method upload()
	 * @description create or update importmap.json file by prefix
	 * @param {object} params, {body: content to write in to file, contentType, prefix: {branch} or 'template'}
	 * @returns {Promise}
	 */
	upload({ body, contentType = 'application/json', prefix = this.BRANCH }) {
		const options = {
			prefix,
			params: { Body: JSON.stringify(body, null, 2), ContentType: contentType },
		};
		return this.s3.upload(this.getParams(options)).promise();
	}

	/**
	 *
	 * @method importMapsContent()
	 * @description get the content for {prefix}.importmaps.json
	 * file and generate config file json for the entry file can
	 * read and register applications
	 * @param {string} prefix {branch} or 'template'
	 * @returns {Promise}
	 */
	importMapsContent(prefix) {
		return new Promise((resolve, reject) => {
			this.s3.getObject(this.getParams({ prefix }), (err, data) => {
				if (!err) {
					const config = {
						modules: [],
						apps: [],
					};

					const jsonRawData = data.Body.toString();

					const jsonParseData = JSON.parse(jsonRawData);

					for (const item of Object.keys(jsonParseData.imports)) {
						const location = jsonParseData.imports[item];
						const locationUrl = new URL(location);
						if (location.includes('route=')) {
							config.apps.push({
								alias: item,
								route: locationUrl.searchParams.get('route'),
								path: locationUrl.pathname,
							});
						} else {
							config.modules.push({
								alias: item,
								path: locationUrl.pathname,
							});
						}
					}
					if (this.type === 'root' && prefix === TEMPLATE) {
						if (fs.existsSync(fileConfigPath)) {
							fs.unlinkSync(fileConfigPath);
						}
						fs.writeFileSync(fileConfigPath, JSON.stringify(config, null, 2));
					}

					resolve({ config, jsonRawData, jsonParseData });
				} else {
					reject(err);
				}
			});
		});
	}

	/**
	 *
	 * @method sortImports()
	 * @description sort imports by index
	 * @param {object} map map.imports
	 * @returns {void}
	 */
	sortImports(map) {
		let importlist = [];

		Object.keys(map.imports).forEach((alias) => {
			const fullPath = new URL(map.imports[alias]);
			importlist.push({
				alias,
				fullPath: fullPath.toString(),
				index: parseInt(fullPath.searchParams.get('index')),
			});
		});

		map.imports = {};

		importlist = importlist.sort((a, b) => a.index - b.index);

		importlist.forEach((item) => {
			map.imports[item.alias] = item.fullPath;
		});
	}

	/**
	 *
	 * @method getRelativePath()
	 * @description getting the relative path
	 * @param {string | number} microtime
	 * @returns {string} {company-app}/{branch}/../file.js?index={index}&router!={router}
	 */
	getRelativePath(microtime = MICROTIME_ZERO) {
		const appFolder = this.appFolder();
		if (this.type === 'app') {
			this.checkEnvs(process.env, ['ROUTE']);
			return `${appFolder}/${this.BRANCH}/js/app.${microtime}.js?index=${this.INDEX}&route=${this.ROUTE}`;
		}
		return `${appFolder}/${this.BRANCH}/${appFolder}.${microtime}.js?index=${this.INDEX}`;
	}

	/**
	 *
	 * @method checkFile()
	 * @param {index} prefix {branch} or 'template
	 * @param {function} callback callback(boolean, data?)
	 * @returns {void}
	 */
	checkFile(prefix, callback) {
		this.s3
			.headObject(this.getParams({ prefix }))
			.promise()
			.then(
				(data) => callback(true, data),
				(err) => {
					if (err.code === 'NotFound') {
						return callback(false);
					}
					throw err;
				}
			);
	}

	/**
	 *
	 * @method getParams()
	 * @description getting params for aws
	 * @param {object} options {prefix: {branch} or 'template', params: Body, ContentType, ... }
	 * @returns {object}
	 */
	getParams({ prefix = this.BRANCH, params = {} }) {
		const importmapsPath = `importmaps/{branch}.importmaps.json`;
		const defaultParams = {
			Bucket: this.CONFIG_BUCKET,
			Key: importmapsPath.replace('{branch}', prefix),
		};
		return Object.assign(defaultParams, params);
	}

	/**
	 *
	 * @method systemImports()
	 * @description generate system imports template for render into index.ejs
	 * @param {object} modules
	 * @returns {string}
	 */
	systemImports(modules) {
		let template = '<script>\n';
		modules.forEach((item) => {
			template += `\t\t\tSystem.import('${item.alias}');\n`;
		});
		template += '\t\t</script>\n';
		return template;
	}

	/**
	 *
	 * @method inlineImportmaps()
	 * @description generate inline import map template for render into index.ejs
	 * @param {string} jsonRawData
	 * @returns {string}
	 */
	inlineImportmaps(jsonRawData, config) {
		const appsRegex = config.apps
			.concat(config.modules)
			.map((item) => item.alias)
			.join('|')
			.replace(/@/g, '')
			.replace(/\//g, '-');

		const regexPath = `/(${appsRegex})/${this.BRANCH}`;

		return jsonRawData
			.replace(new RegExp(regexPath, 'g'), '')
			.replace(new RegExp('\\.' + MICROTIME_ZERO, 'g'), '');
	}

	/**
	 *
	 * @method getMicroTime()
	 * @description getting microtime string
	 * @returns {string}
	 */
	getMicroTime() {
		return this.MODE === LOCAL ? '' : `.${this.microtime}`;
	}

	/**
	 *
	 * @method setAppConfig()
	 * @description set app config for webpack
	 * @param {object} config
	 * @returns {string}
	 */
	setAppConfig(config) {
		config.devServer.port = this.PORT;
		config.output.filename = `js/[name]${this.getMicroTime()}.js`;
		config.output.chunkFilename = `js/[name]${this.getMicroTime()}.js`;
	}
}

module.exports = S3Manager;
