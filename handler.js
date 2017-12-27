"use strict";
const { IS_LOCAL } = process.env;
const git = IS_LOCAL ? Promise.resolve() : require("lambda-git")();
const crypto = require("crypto");
const { exec } = require("child_process");
const mkdirp = require("mkdirp-promise");
const path = require("path");

function signRequestBody(key, body) {
  return `sha1=${crypto
    .createHmac("sha1", key)
    .update(body, "utf-8")
    .digest("hex")}`;
}

const { REPOS_DIR, BRANCH_PREFIX } = process.env;
const token = process.env.GITHUB_WEBHOOK_SECRET;

module.exports.githubWebhookListener = (event, context, callback) => {
  var errMsg; // eslint-disable-line
  const headers = event.headers;
  const sig = headers["X-Hub-Signature"];
  const githubEvent = headers["X-GitHub-Event"];
  const id = headers["X-GitHub-Delivery"];
  const calculatedSig = signRequestBody(token, event.body);

  if (typeof token !== "string") {
    errMsg = "Must provide a 'GITHUB_WEBHOOK_SECRET' env variable";
    return callback(null, {
      statusCode: 401,
      headers: { "Content-Type": "text/plain" },
      body: errMsg
    });
  }

  if (!sig) {
    errMsg = "No X-Hub-Signature found on request";
    return callback(null, {
      statusCode: 401,
      headers: { "Content-Type": "text/plain" },
      body: errMsg
    });
  }

  if (!githubEvent) {
    errMsg = "No X-Github-Event found on request";
    return callback(null, {
      statusCode: 422,
      headers: { "Content-Type": "text/plain" },
      body: errMsg
    });
  }

  if (!id) {
    errMsg = "No X-Github-Delivery found on request";
    return callback(null, {
      statusCode: 401,
      headers: { "Content-Type": "text/plain" },
      body: errMsg
    });
  }

  if (sig !== calculatedSig) {
    errMsg = "X-Hub-Signature incorrect. Github webhook token doesn't match";
    return callback(null, {
      statusCode: 401,
      headers: { "Content-Type": "text/plain" },
      body: errMsg
    });
  }

  /* eslint-disable */
  console.log("---------------------------------");
  console.log(
    `Github-Event: "${githubEvent}" with action: "${event.body.action}"`
  );
  console.log("---------------------------------");
  console.log("Payload", event.body);
  /* eslint-enable */

  // Do custom stuff here with github event data
  // For more on events see https://developer.github.com/v3/activity/events/types/

  let payload = {};
  try {
    console.log(event.body);
    payload = JSON.parse(event.body);
  } catch (error) {
    console.error(error);
    callback(null, {
      statusCode: 400,
      headers: { "Content-Type": "text/plain" },
      body: "Invalid body"
    });
    return;
  }
  const { repository } = payload;
  console.log(JSON.stringify(event, null, 2));
  const repoName = repository.full_name;
  const gitUrl = repository.git_url;
  const headCommit = payload.after;
  const repoPath = path.join(REPOS_DIR, repoName);
  return rmDir(repoPath)
    .catch(() => true)
    .then(() => gitClone(repoName, gitUrl))
    .then(({ stdout, stderr }) => {
      console.log(stdout);
      console.warn(stderr);
    })
    .then(() =>
      gitCheckout(headCommit, {
        cwd: repoPath
      })
    )
    .then(() =>
      gitNewBranch(`${BRANCH_PREFIX}${headCommit}`, {
        cwd: repoPath
      })
    )
    .then(() => rmDir(repoPath))
    .then(() =>
      callback(null, {
        statusCode: 200,
        body: JSON.stringify("Done!")
      })
    )
    .catch(err =>
      rmDir(repoPath)
        .then(() =>
          callback(null, {
            statusCode: 400,
            headers: { "Content-Type": "text/plain" },
            body: err.toString()
          })
        )
        .catch(err =>
          callback(null, {
            statusCode: 400,
            headers: { "Content-Type": "text/plain" },
            body: err.toString()
          })
        )
    );
};

function gitClone(name, cloneUrl) {
  const depth = 50;
  return mkdirp(REPOS_DIR).then(() =>
    gitCommand(`clone --depth=${depth} ${cloneUrl} ${name}`)
  );
}

function gitCommand(
  args,
  options = {
    cwd: REPOS_DIR
  }
) {
  const gitCmd = `git ${args}`;
  console.log(`Command: ${gitCmd}`);
  return git.then(() => {
    return new Promise((resolve, reject) => {
      exec(`git ${args}`, options, (err, stdout, stderr) => {
        if (err) {
          console.error(err);
          return reject(err);
        }
        return resolve({ stdout, stderr });
      });
    });
  });
}

function rmDir(dir) {
  console.log("Remove dir", dir);
  return new Promise((resolve, reject) =>
    exec(`rm -r ${dir}`, (err, stdout, stderr) => {
      if (err) {
        return reject(err);
      }
      if (stderr) {
        return reject(stderr);
      }
      return resolve(stdout);
    })
  );
}

function gitCheckout(commit, options) {
  return gitCommand(`checkout -qf ${commit}`, options);
}

function gitNewBranch(newBranch, options) {
  return gitCommand(`checkout -b ${newBranch}`, options);
}
