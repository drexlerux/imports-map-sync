/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-undef */
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');
require('dotenv').config();

const fileConfigPath = path.resolve('config.json');

const IMPORTSMAP_JSON = 'importsmap.json';
const LOCAL = 'local';
const DEVELOPMENT = 'development';
const PRODUCTION = 'production';
const LOCALHOST = 'localhost';
const MICROTIME_ZERO = '000000';

class S3Manager {
	constructor(type = 'root') {
		this.type = type;
		this.mcTime = Date.now();
		this.options = { importMapsPath: '' };
		this.s3 = new AWS.S3();
		this.checkEnvs(process.env, [
			'APP_ALIAS',
			'CONFIG_BUCKET',
			'PORT',
			'MODE',
			'INDEX',
			'LOCAL_ORIGIN?',
			'PARENT_DEV_CODE_BRANCH?',
		]);

		this.LOCAL_ORIGIN = this.LOCAL_ORIGIN || 'http://localhost';
		this.PARENT_DEV_CODE_BRANCH = this.PARENT_DEV_CODE_BRANCH || 'dev';

		if (this.MODE === LOCAL) {
			this.CODE_BRANCH = LOCALHOST;
		} else {
			this.checkEnvs(process.env, ['CODE_BRANCH']);
			this.options = this.importMapsPath();
		}
	}

	/**
	 *
	 * @method developmentSync()
	 * @description sync imports map for local
	 * @returns {Promise}
	 */
	localSync() {
		return this.checkFile(LOCAL, (exists) => {
			if (!exists) {
				throw new Error(
					`The ${LOCAL}.${IMPORTSMAP_JSON} not found in the ${this.CONFIG_BUCKET}/importmaps, this file is required`
				);
			}

			const pathURL = `${this.LOCAL_ORIGIN}:${
				this.PORT
			}/${this.getRelativePath()}`;

			return this.importMapsContent(LOCAL).then((data) => {
				const { jsonParseData } = data;
				jsonParseData.imports[this.APP_ALIAS] = pathURL;
				this.sortImports(jsonParseData);
				return this.upload({ prefix: LOCAL, body: jsonParseData }).then(
					() => data
				);
			});
		});
	}

	/**
	 *
	 * @method developmentSync()
	 * @description sync imports map for development
	 * @param {string} branch
	 * @returns {Promise}
	 */
	developmentSync(branch) {
		const prtBranch = this.PARENT_DEV_CODE_BRANCH;
		const { origin } = this.options;
		let toUpload = {};
		const branchPathURL = `${origin}/${this.getRelativePath(this.mcTime)}`;
		return this.checkFile(prtBranch, (exists) => {
			if (!exists) {
				throw new Error(
					`The ${parentDevBranch}.${IMPORTSMAP_JSON} not found in the ${this.CONFIG_BUCKET}/importmaps, this file is required`
				);
			}

			return this.importMapsContent(prtBranch).then((prtData) => {
				const prtJsonParseData = prtData.jsonParseData;

				if (branch !== prtBranch) {
					return this.checkFile(branch, (exists2) => {
						//Si el archivo con branch child no existe toma lo que viene del parent y replaza el alias actual
						if (!exists2) {
							prtJsonParseData.imports[this.APP_ALIAS] = branchPathURL;
							toUpload = { prefix: branch, body: prtJsonParseData };
							return this.upload(toUpload).then(() => prtData);
						}

						return this.importMapsContent(branch).then((data) => {
							const jsonParseData = data.jsonParseData;

							Object.keys(prtJsonParseData.imports).forEach((prtItem) => {
								if (!Object.keys(jsonParseData.imports).includes(prtItem)) {
									jsonParseData.imports[prtItem] =
										prtJsonParseData.imports[prtItem];
								}
							});

							jsonParseData.imports[this.APP_ALIAS] = branchPathURL;

							this.sortImports(jsonParseData);

							toUpload = { prefix: branch, body: jsonParseData };

							return this.upload(toUpload).then(() => data);
						});
					});
				} else {
					prtJsonParseData.imports[this.APP_ALIAS] = branchPathURL;

					this.sortImports(prtJsonParseData);

					toUpload = { prefix: branch, body: prtJsonParseData };

					return this.upload(toUpload).then(() => prtData);
				}
			});
		});
	}

	/**
	 *
	 * @method productionSync()
	 * @description sync imports map for production
	 * @returns {Promise}
	 */
	productionSync() {
		const { origin } = this.options;
		let toUpload = {};
		const pathURL = `${origin}/${this.getRelativePath(this.mcTime)}`.replace(
			`${this.CODE_BRANCH}/`,
			''
		);

		return this.checkFile(this.CODE_BRANCH, (exists) => {
			if (!exists) {
				console.warn(
					`The ${this.CODE_BRANCH}.${IMPORTSMAP_JSON} not found in the ${this.CONFIG_BUCKET}/importmaps, this file will be create`
				);

				const data = { imports: {} };

				data.config = {
					apps: [],
					modules: [],
				};

				data.imports[this.APP_ALIAS] = pathURL;

				toUpload = { prefix: this.CODE_BRANCH, body: data };

				return this.upload(toUpload).then(() => data);
			}

			return this.importMapsContent(this.CODE_BRANCH).then((data) => {
				const { jsonParseData } = data;
				jsonParseData.imports[this.APP_ALIAS] = pathURL;
				this.sortImports(jsonParseData);
				toUpload = { prefix: this.CODE_BRANCH, body: jsonParseData };
				return this.upload(toUpload).then(() => data);
			});
		});
	}

	/**
	 *
	 * @method launch()
	 * @description deployment launcher
	 * @returns {Promise}
	 */
	launch() {
		if (this.MODE === LOCAL) {
			return this.localSync();
		} else if (this.MODE === DEVELOPMENT) {
			return this.developmentSync(this.CODE_BRANCH);
		}

		return this.productionSync();
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
	 * @param {object} params, {body: content to write in to file, contentType, prefix: {branch} | 'local' | 'production'}
	 * @returns {Promise}
	 */
	upload({
		body,
		contentType = 'application/json',
		prefix = this.CODE_BRANCH,
	}) {
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
	 * @param {string} prefix {branch} | 'local' | 'production'
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
					if (this.type === 'root') {
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
			return `${appFolder}/${this.CODE_BRANCH}/js/app.${microtime}.js?index=${this.INDEX}&route=${this.ROUTE}`;
		}
		return `${appFolder}/${this.CODE_BRANCH}/${appFolder}.${microtime}.js?index=${this.INDEX}`;
	}

	/**
	 *
	 * @method checkFile()
	 * @param {index} prefix {branch} or 'template
	 * @param {function} callback callback(boolean, data?)
	 * @returns {void}
	 */
	checkFile(prefix, callback) {
		return this.s3
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
	 * @param {object} options {prefix: {branch} | 'local' | 'production', params: Body, ContentType, ... }
	 * @returns {object}
	 */
	getParams({ prefix = this.CODE_BRANCH, params = {} }) {
		const importmapsPath = `importmaps/{branch}.${IMPORTSMAP_JSON}`;
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

		const regexPath = `/(${appsRegex})/${this.CODE_BRANCH}`;

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
		return this.MODE === LOCAL ? '' : `.${this.mcTime}`;
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
