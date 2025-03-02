import PercyEnv from '@percy/env';
import { git } from '@percy/env/dist/utils';
import logger from '@percy/logger';
import pkg from '../package.json';

import { sha256hash, base64encode, pool } from './utils';
import request from './request';

// Default client API URL can be set with an env var for API development
const { PERCY_CLIENT_API_URL = 'https://percy.io/api/v1' } = process.env;

// Validate build ID arguments
function validateBuildId(id) {
  if (!id) throw new Error('Missing build ID');
  if (!(typeof id === 'string' || typeof id === 'number')) {
    throw new Error('Invalid build ID');
  }
}

// Validate project path arguments
function validateProjectPath(path) {
  if (!path) throw new Error('Missing project path');
  if (!/^[^/]+?\/.+/.test(path)) {
    throw new Error(`Invalid project path. Expected "org/project" but received "${path}"`);
  }
}

// PercyClient is used to communicate with the Percy API to create and finalize
// builds and snapshot. Uses @percy/env to collect environment information used
// during build creation.
export class PercyClient {
  log = logger('client');
  env = new PercyEnv(process.env);
  clientInfo = new Set();
  environmentInfo = new Set();

  constructor({
    // read or write token, defaults to PERCY_TOKEN environment variable
    token,
    // initial user agent info
    clientInfo,
    environmentInfo,
    // versioned api url
    apiUrl = PERCY_CLIENT_API_URL
  } = {}) {
    Object.assign(this, { token, apiUrl });
    this.addClientInfo(clientInfo);
    this.addEnvironmentInfo(environmentInfo);
  }

  // Adds additional unique client info.
  addClientInfo(info) {
    for (let i of [].concat(info)) {
      if (i) this.clientInfo.add(i);
    }
  }

  // Adds additional unique environment info.
  addEnvironmentInfo(info) {
    for (let i of [].concat(info)) {
      if (i) this.environmentInfo.add(i);
    }
  }

  // Stringifies client and environment info.
  userAgent() {
    let client = new Set([`Percy/${/\w+$/.exec(this.apiUrl)}`]
      .concat(`${pkg.name}/${pkg.version}`, ...this.clientInfo)
      .filter(Boolean));
    let environment = new Set([...this.environmentInfo]
      .concat(`node/${process.version}`, this.env.info)
      .filter(Boolean));

    return `${[...client].join(' ')} (${[...environment].join('; ')})`;
  }

  // Checks for a Percy token and returns it.
  getToken() {
    let token = this.token || this.env.token;
    if (!token) throw new Error('Missing Percy token');
    return token;
  }

  // Returns common headers used for each request with additional
  // headers. Throws an error when the token is missing, which is a required
  // authorization header.
  headers(headers) {
    return Object.assign({
      Authorization: `Token token=${this.getToken()}`,
      'User-Agent': this.userAgent()
    }, headers);
  }

  // Performs a GET request for an API endpoint with appropriate headers.
  get(path) {
    return request(`${this.apiUrl}/${path}`, {
      method: 'GET',
      headers: this.headers()
    });
  }

  // Performs a POST request to a JSON API endpoint with appropriate headers.
  post(path, body = {}) {
    return request(`${this.apiUrl}/${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: this.headers({
        'Content-Type': 'application/vnd.api+json'
      })
    });
  }

  // Creates a build with optional build resources. Only one build can be
  // created at a time per instance so snapshots and build finalization can be
  // done more seemlessly without manually tracking build ids
  async createBuild({ resources = [] } = {}) {
    this.log.debug('Creating a new build...');

    return this.post('builds', {
      data: {
        type: 'builds',
        attributes: {
          branch: this.env.git.branch,
          'target-branch': this.env.target.branch,
          'target-commit-sha': this.env.target.commit,
          'commit-sha': this.env.git.sha,
          'commit-committed-at': this.env.git.committedAt,
          'commit-author-name': this.env.git.authorName,
          'commit-author-email': this.env.git.authorEmail,
          'commit-committer-name': this.env.git.committerName,
          'commit-committer-email': this.env.git.committerEmail,
          'commit-message': this.env.git.message,
          'pull-request-number': this.env.pullRequest,
          'parallel-nonce': this.env.parallel.nonce,
          'parallel-total-shards': this.env.parallel.total,
          partial: this.env.partial
        },
        relationships: {
          resources: {
            data: resources.map(r => ({
              type: 'resources',
              id: r.sha || sha256hash(r.content),
              attributes: {
                'resource-url': r.url,
                'is-root': r.root || null,
                mimetype: r.mimetype || null
              }
            }))
          }
        }
      }
    });
  }

  // Finalizes the active build. When `all` is true, `all-shards=true` is
  // added as a query param so the API finalizes all other build shards.
  async finalizeBuild(buildId, { all = false } = {}) {
    validateBuildId(buildId);
    let qs = all ? 'all-shards=true' : '';
    this.log.debug(`Finalizing build ${buildId}...`);
    return this.post(`builds/${buildId}/finalize?${qs}`);
  }

  // Retrieves build data by id. Requires a read access token.
  async getBuild(buildId) {
    validateBuildId(buildId);
    this.log.debug(`Get build ${buildId}`);
    return this.get(`builds/${buildId}`);
  }

  // Retrieves project builds optionally filtered. Requires a read access token.
  async getBuilds(project, filters = {}) {
    validateProjectPath(project);

    let qs = Object.keys(filters).map(k => (
      Array.isArray(filters[k])
        ? filters[k].map(v => `filter[${k}][]=${v}`).join('&')
        : `filter[${k}]=${filters[k]}`
    )).join('&');

    this.log.debug(`Fetching builds for ${project}`);
    return this.get(`projects/${project}/builds?${qs}`);
  }

  // Resolves when the build has finished and is no longer pending or
  // processing. By default, will time out if no update after 10 minutes.
  waitForBuild({
    build,
    project,
    commit,
    timeout = 10 * 60 * 1000,
    interval = 1000
  }, onProgress) {
    if (commit && !project) {
      throw new Error('Missing project path for commit');
    } else if (!commit && !build) {
      throw new Error('Missing build ID or commit SHA');
    } else if (project) {
      validateProjectPath(project);
    }

    let sha = commit && (git(`rev-parse ${commit}`) || commit);

    let fetchData = async () => build
      ? (await this.getBuild(build)).data
      : (await this.getBuilds(project, { sha })).data[0];

    this.log.debug(`Waiting for build ${build || `${project} (${commit})`}...`);

    // recursively poll every second until the build finishes
    return new Promise((resolve, reject) => (async function poll(last, t) {
      try {
        let data = await fetchData();
        let state = data?.attributes.state;
        let pending = !state || state === 'pending' || state === 'processing';
        let updated = JSON.stringify(data) !== JSON.stringify(last);

        // new data received
        if (updated) {
          t = Date.now();

        // no new data within the timeout
        } else if (Date.now() - t >= timeout) {
          throw new Error('Timeout exceeded without an update');
        }

        // call progress every update after the first update
        if ((last || pending) && updated) {
          onProgress?.(data);
        }

        // not finished, poll again
        if (pending) {
          return setTimeout(poll, interval, data, t);

        // build finished
        } else {
          // ensure progress is called at least once
          if (!last) onProgress?.(data);
          resolve({ data });
        }
      } catch (err) {
        reject(err);
      }
    })(null, Date.now()));
  }

  // Uploads a single resource to the active build. If `filepath` is provided,
  // `content` is read from the filesystem. The sha is optional and will be
  // created from `content` if one is not provided.
  async uploadResource(buildId, { url, sha, filepath, content } = {}) {
    validateBuildId(buildId);

    this.log.debug(`Uploading resource: ${url}...`);

    content = filepath
      ? require('fs').readFileSync(filepath)
      : content;

    return this.post(`builds/${buildId}/resources`, {
      data: {
        type: 'resources',
        id: sha || sha256hash(content),
        attributes: {
          'base64-content': base64encode(content)
        }
      }
    });
  }

  // Uploads resources to the active build concurrently, two at a time.
  async uploadResources(buildId, resources) {
    validateBuildId(buildId);

    this.log.debug(`Uploading resources for ${buildId}...`);

    return pool(function*() {
      for (let resource of resources) {
        yield this.uploadResource(buildId, resource);
      }
    }, this, 2);
  }

  // Creates a snapshot for the active build using the provided attributes.
  async createSnapshot(buildId, {
    name,
    widths,
    minHeight,
    enableJavaScript,
    clientInfo,
    environmentInfo,
    resources = []
  } = {}) {
    validateBuildId(buildId);
    this.addClientInfo(clientInfo);
    this.addEnvironmentInfo(environmentInfo);

    if (!this.clientInfo.size || !this.environmentInfo.size) {
      this.log.warn('Warning: Missing `clientInfo` and/or `environmentInfo` properties');
    }

    this.log.debug(`Creating snapshot: ${name}...`);

    return this.post(`builds/${buildId}/snapshots`, {
      data: {
        type: 'snapshots',
        attributes: {
          name: name || null,
          widths: widths || null,
          'minimum-height': minHeight || null,
          'enable-javascript': enableJavaScript || null
        },
        relationships: {
          resources: {
            data: resources.map(r => ({
              type: 'resources',
              id: r.sha || sha256hash(r.content),
              attributes: {
                'resource-url': r.url || null,
                'is-root': r.root || null,
                mimetype: r.mimetype || null
              }
            }))
          }
        }
      }
    });
  }

  // Finalizes a snapshot.
  async finalizeSnapshot(snapshotId) {
    if (!snapshotId) throw new Error('Missing snapshot ID');
    this.log.debug(`Finalizing snapshot ${snapshotId}...`);
    return this.post(`snapshots/${snapshotId}/finalize`);
  }

  // Convenience method for creating a snapshot for the active build, uploading
  // missing resources for the snapshot, and finalizing the snapshot.
  async sendSnapshot(buildId, options) {
    let snapshot = await this.createSnapshot(buildId, options);
    let missing = snapshot.data.relationships?.['missing-resources']?.data;

    if (missing?.length) {
      let resources = options.resources.reduce((acc, r) => Object.assign(acc, { [r.sha]: r }), {});
      await this.uploadResources(buildId, missing.map(({ id }) => resources[id]));
    }

    await this.finalizeSnapshot(snapshot.data.id);
    return snapshot;
  }
}

export default PercyClient;
