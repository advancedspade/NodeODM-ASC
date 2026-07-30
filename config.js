/*
NodeODM App and REST API to access ODM.
Copyright (C) 2016 NodeODM Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
'use strict';

let fs = require('fs');
const path = require('path');

(function loadEnvFromDotenvFile() {
	try {
		const envPath = path.join(__dirname, '.env');
		if (!fs.existsSync(envPath)) return;
		let text = fs.readFileSync(envPath, 'utf8');
		if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
		for (const rawLine of text.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith('#')) continue;
			const eq = line.indexOf('=');
			if (eq === -1) continue;
			const key = line.slice(0, eq).trim();
			if (!key) continue;
			let val = line.slice(eq + 1).trim();
			if (
				(val.startsWith('"') && val.endsWith('"')) ||
				(val.startsWith("'") && val.endsWith("'"))
			) {
				val = val.slice(1, -1);
			}
			if (process.env[key] === undefined) {
				process.env[key] = val;
			}
		}
	} catch (e) {
		// ignore missing or unreadable .env
	}
})();

let argv = require('minimist')(process.argv.slice(2));
let utils = require('./libs/utils');
let apps = require('./libs/apps');
const spawnSync = require('child_process').spawnSync;

if (argv.help){
	console.log(`
Usage: node index.js [options]

Options:
	--config <path>	Path to the configuration file (default: config-default.json)	
	-p, --port <number> 	Port to bind the server to, or "auto" to automatically find an available port (default: 3000)
	--odm_path <path>	Path to ODM's code	(default: /code)
	--log_level <logLevel>	Set log level verbosity (default: info)
	-d, --daemon 	Set process to run as a deamon
	-q, --parallel_queue_processing <number> Number of simultaneous processing tasks (default: 2)
	--cleanup_tasks_after <number> Number of minutes that elapse before deleting finished and canceled tasks (default: 2880) 
	--cleanup_uploads_after <number> Number of minutes that elapse before deleting unfinished uploads. Set this value to the maximum time you expect a dataset to be uploaded. (default: 2880) 
	--test Enable test mode. In test mode, no commands are sent to ODM. This can be useful during development or testing (default: false)
	--test_skip_orthophotos	If test mode is enabled, skip orthophoto results when generating assets. (default: false) 
	--test_skip_dems	If test mode is enabled, skip dems results when generating assets. (default: false) 
	--test_drop_uploads	If test mode is enabled, drop /task/new/upload requests with 50% probability. (default: false)
	--test_fail_tasks	If test mode is enabled, mark tasks as failed. (default: false)
	--test_seconds	If test mode is enabled, sleep these many seconds before finishing processing a test task. (default: 0)
	--powercycle	When set, the application exits immediately after powering up. Useful for testing launch and compilation issues.
	--token <token>	Sets a token that needs to be passed for every request. This can be used to limit access to the node only to token holders. (default: none)
	Google OAuth (optional — enables /login.html and cookie session; requires all of the following when used):
	--oauth_google_client_id <id>	Web application OAuth 2.0 Client ID from Google Cloud Console.
	--oauth_google_client_secret <secret>	Client secret for the same OAuth client.
	--oauth_google_redirect_uri <url>	Must exactly match an authorized redirect URI (e.g. https://your-host/auth/google/callback).
	--session_secret <string>	Secret used to sign session cookies (use a long random string). For cross-host sign-in between dronemaps and superdrone, use the same value on both servers.
	--oauth_allowed_domains <list>	Optional comma-separated email domains (e.g. example.com,other.org). If set, only Google accounts whose address is exactly user@domain for one of those domains may sign in.
	--oauth_session_days <n>	OAuth session length in days (JWT + cookie, 1–365). Default: 30.
	--portal_staging_env_url <url>	Public origin for the dronemaps NodeODM host (e.g. https://dronemaps.example.com).
	--portal_staging_env_label <text>	Label for that host (e.g. dronemaps).
	--portal_staging_env_tagline <text>	Short description on the portal (e.g. standard capacity).
	--portal_super_env_url <url>	Public origin for the superdrone NodeODM host (e.g. https://superdrone.example.com).
	--portal_super_env_label <text>	Label for that host (e.g. superdrone).
	--portal_super_env_tagline <text>	Short description on the portal (e.g. high capacity).
	--max_images <number>	Specify the maximum number of images that this processing node supports. (default: unlimited)
	--webhook <url>	Specify a POST URL endpoint to be invoked when a task completes processing (default: none)
	--s3_endpoint <url>	Specify a S3 endpoint (for example, nyc3.digitaloceanspaces.com) to upload completed task results to. (default: do not upload to S3)
	--s3_bucket <bucket>	Specify a S3 bucket name where to upload completed task results to. (default: none)
	--s3_access_key <key>	S3 access key, required if --s3_endpoint is set. (default: none)
	--s3_force_path_style  Whether to force path style URLs for S3 objects. (default: false)
	--s3_secret_key <secret>	S3 secret key, required if --s3_endpoint is set. (default: none) 
	--s3_signature_version <version>	S3 signature version. (default: 4)
	--s3_acl <canned-acl> S3 object acl. Can specify "none" to skip. (default: public-read)
	--s3_upload_everything	Upload all task results to S3. (default: upload only all.zip archive)
	--s3_ignore_ssl Whether to ignore SSL errors while connecting to S3. (default: false)
	--max_concurrency   <number>	Place a cap on the max-concurrency option to use for each task. (default: no limit, auto-calculated based on memory if not set)
	--max_runtime	<number> Number of minutes (approximate) that a task is allowed to run before being forcibly canceled (timeout). (default: no limit)
	--docker_memory_limit <size>	Docker container memory limit (e.g., "8g", "16g"). Set this to prevent OOM kills. (default: no limit)

GCS (Google Cloud Storage) Options:
	--gcs_bucket <bucket>	GCS bucket name for uploading results. (default: none)
	--gcs_project_id <id>	GCS project ID. (default: auto-detect from credentials)
	--gcs_key_path <path>	Path to GCS service account JSON key file. (default: use default credentials)
	--gcs_parallel_uploads <number>	Number of parallel file uploads to GCS. (default: 16)
	--gcs_upload_paths <paths>	Comma-separated list of paths to upload to GCS. Use "." for entire task folder. (default: .)
	--gcs_upload_prefix <prefix>	Prefix path in GCS bucket (e.g., 'outputs' results in gs://bucket/outputs/task-uuid/). (default: none)
	--gcs_cleanup_after_upload	Delete local files after successful GCS upload. (default: false)
	--gcs_task_archive	Also upload all.zip to <task-uuid>/all.zip for ClusterODM post-teardown downloads. (default: false)

Log Levels: 
error | debug | info | verbose | debug | silly 
`);
	process.exit(0);
}

const allOpts = ["slice","help","config","odm_path","log_level","port","p",
"deamonize","daemon","d","parallel_queue_processing","q",
"cleanup_tasks_after","cleanup_uploads_after","test","test_skip_orthophotos",
"test_skip_dems","test_drop_uploads","test_fail_tasks","test_seconds",
"powercycle","token","oauth_google_client_id","oauth_google_client_secret",
"oauth_google_redirect_uri","session_secret","oauth_allowed_domains",
"max_images","webhook","s3_endpoint","s3_bucket",
"s3_force_path_style","s3_access_key","s3_secret_key","s3_signature_version",
"s3_acl","s3_upload_everything","s3_ignore_ssl","max_concurrency","max_runtime",
"gcs_bucket","gcs_project_id","gcs_key_path","gcs_parallel_uploads",
"gcs_upload_paths","gcs_upload_prefix","gcs_cleanup_after_upload","gcs_task_archive",
"portal_staging_env_url","portal_staging_env_label","portal_staging_env_tagline","portal_super_env_url","portal_super_env_label","portal_super_env_tagline","oauth_session_days"];

// Support for "-" or "_" style params syntax
for (let k in argv){
    if (k === "_") continue;
    
    const opt = k.replace(/-/g, "_");
    argv[opt] = argv[k];
    if (allOpts.indexOf(opt) === -1){
        console.log(`warning: Unrecognized flag ${k}`);
    }
}

let config = {};

// Read configuration from file
let configFilePath = argv.config || "config-default.json";
let configFile = {};

if (/\.json$/i.test(configFilePath)){
	try{
		let data = fs.readFileSync(configFilePath);
		configFile = JSON.parse(data.toString());
	}catch(e){
		console.log(`Invalid configuration file ${configFilePath}`);
		process.exit(1);
	}
}

// Gets a property that might not exist from configuration file
// example: fromConfigFile("logger.maxFileSize", 1000);
function fromConfigFile(prop, defaultValue){
	return utils.get(configFile, prop, defaultValue);
}

// Instance name - default name for this configuration
config.instance = fromConfigFile("instance", 'node-OpenDroneMap');
config.odm_path = argv.odm_path || fromConfigFile("odm_path", '/code');

// Logging configuration
config.logger = {};
config.logger.level = argv.log_level || fromConfigFile("logger.level", 'info'); // What level to log at; info, verbose or debug are most useful. Levels are (npm defaults): silly, debug, verbose, info, warn, error.
config.logger.maxFileSize = fromConfigFile("logger.maxFileSize", 1024 * 1024 * 100); // Max file size in bytes of each log file; default 100MB
config.logger.maxFiles = fromConfigFile("logger.maxFiles", 10); // Max number of log files kept
config.logger.logDirectory = fromConfigFile("logger.logDirectory", ''); // Set this to a full path to a directory - if not set logs will be written to the application directory.

config.port = (argv.port || argv.p || fromConfigFile("port", process.env.PORT || "auto"));
config.deamon = argv.deamonize || argv.daemon || argv.d || fromConfigFile("daemon", false);
config.parallelQueueProcessing = parseInt(argv.parallel_queue_processing || argv.q || fromConfigFile("parallelQueueProcessing", 1));
config.cleanupTasksAfter = parseInt(argv.cleanup_tasks_after || fromConfigFile("cleanupTasksAfter", 2880));
config.cleanupUploadsAfter = parseInt(argv.cleanup_uploads_after || fromConfigFile("cleanupUploadsAfter", 2880));
config.test = argv.test || fromConfigFile("test", false);
config.testSkipOrthophotos = argv.test_skip_orthophotos || fromConfigFile("testSkipOrthophotos", false);
config.testSkipDems = argv.test_skip_dems || fromConfigFile("testSkipDems", false);
config.testDropUploads = argv.test_drop_uploads || fromConfigFile("testDropUploads", false);
config.testFailTasks = argv.test_fail_tasks || fromConfigFile("testFailTasks", false);
config.testSeconds = parseInt(argv.test_seconds || fromConfigFile("testSeconds", 0));
config.powercycle = argv.powercycle || fromConfigFile("powercycle", false);
config.token = argv.token || fromConfigFile("token", "") || process.env.NODEODM_TOKEN || "";
// Prefer CLI, then JSON; treat empty JSON as unset so .env (loaded above) can supply values.
config.oauthGoogleClientId = argv.oauth_google_client_id || fromConfigFile("oauthGoogleClientId", "") || process.env.OAUTH_GOOGLE_CLIENT_ID || "";
config.oauthGoogleClientSecret = argv.oauth_google_client_secret || fromConfigFile("oauthGoogleClientSecret", "") || process.env.OAUTH_GOOGLE_CLIENT_SECRET || "";
config.oauthGoogleRedirectUri = argv.oauth_google_redirect_uri || process.env.OAUTH_GOOGLE_REDIRECT_URI || fromConfigFile("oauthGoogleRedirectUri", "") || "";
config.sessionSecret = argv.session_secret || fromConfigFile("sessionSecret", "") || process.env.SESSION_SECRET || "";
["oauthGoogleClientId", "oauthGoogleClientSecret", "oauthGoogleRedirectUri", "sessionSecret"].forEach(k => {
	if (typeof config[k] === "string") config[k] = config[k].trim();
});
const _oauthDomainsRaw = argv.oauth_allowed_domains || fromConfigFile("oauthAllowedDomains", "") || process.env.OAUTH_ALLOWED_DOMAINS || "";
config.oauthAllowedDomains = String(_oauthDomainsRaw).split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
config.oauthCookieName = fromConfigFile("oauthCookieName", "ndm_oauth");
config.oauthSessionDays = Math.min(
	365,
	Math.max(
		1,
		parseInt(
			argv.oauth_session_days ||
				fromConfigFile("oauthSessionDays", "") ||
				process.env.OAUTH_SESSION_DAYS ||
				"30",
			10
		) || 30
	)
);
function portalOriginFromRaw(raw) {
	const u = String(raw || "")
		.trim()
		.replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(u)) return "";
	try {
		return new URL(u).origin;
	} catch (e) {
		return "";
	}
}
// Which hosts a deployment pairs with is deployment-specific, so the origins
// must stay empty in config-default.json. An unset env var is falsy and falls
// through to the file, so a non-empty origin there would silently pair every
// standalone host with whatever the file names — and cross-host sign-in then
// fails with bridge_invalid unless both hosts share a SESSION_SECRET.
config.portalStagingEnvOrigin = portalOriginFromRaw(
	argv.portal_staging_env_url ||
		process.env.PORTAL_STAGING_ENV_URL ||
		fromConfigFile("portalStagingEnvOrigin", "") ||
		""
);
config.portalSuperEnvOrigin = portalOriginFromRaw(
	argv.portal_super_env_url ||
		process.env.PORTAL_SUPER_ENV_URL ||
		fromConfigFile("portalSuperEnvOrigin", "") ||
		""
);
config.portalStagingEnvLabel =
	argv.portal_staging_env_label ||
	process.env.PORTAL_STAGING_ENV_LABEL ||
	fromConfigFile("portalStagingEnvLabel", "") ||
	"dronemaps";
config.portalSuperEnvLabel =
	argv.portal_super_env_label ||
	process.env.PORTAL_SUPER_ENV_LABEL ||
	fromConfigFile("portalSuperEnvLabel", "") ||
	"superdrone";
if (typeof config.portalStagingEnvLabel === "string") {
	config.portalStagingEnvLabel = config.portalStagingEnvLabel.trim();
}
if (typeof config.portalSuperEnvLabel === "string") {
	config.portalSuperEnvLabel = config.portalSuperEnvLabel.trim();
}
const _portalStTag =
	argv.portal_staging_env_tagline ||
	process.env.PORTAL_STAGING_ENV_TAGLINE ||
	fromConfigFile("portalStagingEnvTagline", "") ||
	"";
const _portalSuTag =
	argv.portal_super_env_tagline ||
	process.env.PORTAL_SUPER_ENV_TAGLINE ||
	fromConfigFile("portalSuperEnvTagline", "") ||
	"";
config.portalStagingEnvTagline = String(_portalStTag).trim() || "Standard capacity — everyday maps and processing.";
config.portalSuperEnvTagline = String(_portalSuTag).trim() || "High capacity — large projects and heavier processing.";
config.oauthEnabled = !!(config.oauthGoogleClientId && config.oauthGoogleClientSecret && config.oauthGoogleRedirectUri && config.sessionSecret);
config.authorizedIps = fromConfigFile("authorizedIps", []);
config.maxImages = parseInt(argv.max_images || fromConfigFile("maxImages", "")) || null;
config.webhook = argv.webhook || fromConfigFile("webhook", "");
config.s3Endpoint = argv.s3_endpoint || fromConfigFile("s3Endpoint", "");
config.s3Bucket = argv.s3_bucket || fromConfigFile("s3Bucket", "");
config.s3ForcePathStyle = argv.s3_force_path_style || fromConfigFile("s3ForcePathStyle", false);
config.s3AccessKey = argv.s3_access_key || fromConfigFile("s3AccessKey", process.env.AWS_ACCESS_KEY_ID || "")
config.s3SecretKey = argv.s3_secret_key || fromConfigFile("s3SecretKey", process.env.AWS_SECRET_ACCESS_KEY || "")
config.s3SignatureVersion = argv.s3_signature_version || fromConfigFile("s3SignatureVersion", "4")
config.s3ACL = argv.s3_acl || fromConfigFile("s3_acl", "public-read")
config.s3UploadEverything = argv.s3_upload_everything || fromConfigFile("s3UploadEverything", false);
config.s3IgnoreSSL = argv.s3_ignore_ssl || fromConfigFile("s3IgnoreSSL", false);
config.maxConcurrency = parseInt(argv.max_concurrency || fromConfigFile("maxConcurrency", 0));
config.maxRuntime = parseInt(argv.max_runtime || fromConfigFile("maxRuntime", -1));
config.dockerMemoryLimit = argv.docker_memory_limit || fromConfigFile("dockerMemoryLimit", "");

// GCS (Google Cloud Storage) configuration
// Empty strings in config-default.json must not block env vars (GCS_BUCKET, etc.).
config.gcsBucket = argv.gcs_bucket || fromConfigFile("gcsBucket", "") || process.env.GCS_BUCKET || "";
config.gcsProjectId = argv.gcs_project_id || fromConfigFile("gcsProjectId", "") || process.env.GCS_PROJECT_ID || "";
config.gcsKeyPath = argv.gcs_key_path || fromConfigFile("gcsKeyPath", "") ||
	process.env.GCS_KEY_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS || "";
config.gcsParallelUploads = parseInt(argv.gcs_parallel_uploads || fromConfigFile("gcsParallelUploads", 16));
config.gcsUploadPaths = argv.gcs_upload_paths || fromConfigFile("gcsUploadPaths", ".");
config.gcsUploadPrefix = argv.gcs_upload_prefix || fromConfigFile("gcsUploadPrefix", "") || process.env.GCS_UPLOAD_PREFIX || "";
// Boolean flag - check for explicit true/false or presence of flag
config.gcsCleanupAfterUpload = argv.gcs_cleanup_after_upload === true || 
    argv.gcs_cleanup_after_upload === 'true' || 
    fromConfigFile("gcsCleanupAfterUpload", false) === true;
config.gcsTaskArchive = argv.gcs_task_archive === true ||
    argv.gcs_task_archive === 'true' ||
    fromConfigFile("gcsTaskArchive", false) === true;

config.rtkAnalysis = argv.no_rtk_analysis
    ? false
    : (argv.rtk_analysis === false || argv.rtk_analysis === "false"
        ? false
        : fromConfigFile("rtkAnalysis", true));

// Detect 7z availability
config.has7z = spawnSync(apps.sevenZ, ['--help']).status === 0;
config.hasUnzip = spawnSync(apps.unzip, ['--help']).status === 0;


module.exports = config;
