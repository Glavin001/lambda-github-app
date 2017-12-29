"use strict";
const {
  IS_LOCAL,
  REPOS_DIR,
  BRANCH_PREFIX,
  APP_ID,
  CERT,
  README_PATH,
  GIT_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL,
  STATUS_CONTEXT_PREFIX
} = process.env;
const git = IS_LOCAL ? Promise.resolve() : require("lambda-git")();
const crypto = require("crypto");
const { exec } = require("child_process");
const mkdirp = require("mkdirp-promise");
const path = require("path");
const createApp = require("github-app");
const fs = require("fs");

const pkg = require("./package.json");

function signRequestBody(key, body) {
  return `sha1=${crypto
    .createHmac("sha1", key)
    .update(body, "utf-8")
    .digest("hex")}`;
}

const token = process.env.GITHUB_WEBHOOK_SECRET;
const app = createApp({
  // Your app id
  id: APP_ID,
  // The private key for your app, which can be downloaded from the
  // app's settings: https://github.com/settings/apps
  cert: fs.readFileSync(CERT)
});

module.exports.githubWebhookListener = (event, context, callback) => {
  try {
    let errMsg;
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

    if (githubEvent !== "push") {
      return callback(null, {
        statusCode: 200,
        body: "Pong!"
      });
    }

    console.log(JSON.stringify(event, null, 2));

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

    const { ref, repository, head_commit: headCommit } = payload;
    const installationId = payload.installation.id;
    if (!(repository && installationId && ref && headCommit)) {
      errMsg = "No repository found.";
      return callback(null, {
        statusCode: 400,
        headers: { "Content-Type": "text/plain" },
        body: errMsg
      });
    }

    const isAppBranch = ref.startsWith(`refs/heads/${BRANCH_PREFIX}`);
    if (isAppBranch) {
      return callback(null, {
        statusCode: 200,
        body: `Created by ${pkg.name}`
      });
    }

    const repoName = repository.full_name;
    const cloneUrl = repository.clone_url;
    const commitId = headCommit.id;
    const repoPath = path.join(REPOS_DIR, repoName);
    const newBranchName = `${BRANCH_PREFIX}${commitId}`;
    return app.asInstallation(installationId).then(github =>
      github.repos
        .createStatus({
          owner: repository.owner.name,
          repo: repository.name,
          sha: commitId,
          state: "pending",
          context: STATUS_CONTEXT_PREFIX,
          description: "Working on it!",
          target_url: pkg.homepage
        })
        .then(() =>
          rmDir(repoPath)
            .catch(() => true)
            .then(() =>
              gitClone(repoName, cloneUrlWithToken(cloneUrl, github.auth.token))
            )
            .then(() =>
              gitConfigUser(GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, {
                cwd: repoPath
              })
            )
            .then(() => gitLogUser({ cwd: repoPath }))
            .then(() =>
              gitFetch("origin", ref, {
                cwd: repoPath
              })
            )
            .then(() =>
              gitCheckout(commitId, {
                cwd: repoPath
              })
            )
            .then(() =>
              gitNewBranch(newBranchName, {
                cwd: repoPath
              })
            )
            .then(() => gitStatus({ cwd: repoPath }))
            .then(logGitOutput)
            .then(
              () =>
                new Promise((resolve, reject) => {
                  const readmePath = path.join(repoPath, README_PATH);
                  const data = `Updated at ${new Date().toLocaleString()} for commit ${commitId} of ${ref}`;
                  fs.appendFile(readmePath, data, error => {
                    if (error) {
                      return reject(error);
                    }
                    return resolve();
                  });
                })
            )
            .then(() => gitStatus({ cwd: repoPath }))
            .then(logGitOutput)
            .then(() => gitAddAll({ cwd: repoPath }))
            .then(() => gitStatus({ cwd: repoPath }))
            .then(logGitOutput)
            .then(() =>
              gitCommit(`Update README for ${commitId}`, { cwd: repoPath })
            )
            .then(logGitOutput)
            .then(() =>
              gitPushAndSetUpstream(newBranchName, "origin", { cwd: repoPath })
            )
            .then(logGitOutput)
            .then(() => rmDir(repoPath))
            .then(() =>
              github.repos.createStatus({
                owner: repository.owner.name,
                repo: repository.name,
                sha: commitId,
                state: "success",
                context: STATUS_CONTEXT_PREFIX,
                description: "Victory!!!",
                target_url: pkg.homepage
              })
            )
            .then(() =>
              callback(null, {
                statusCode: 200,
                body: "Done!"
              })
            )
            .catch(err => {
              const cb = () =>
                callback(null, {
                  statusCode: 400,
                  headers: { "Content-Type": "text/plain" },
                  body: err.toString()
                });
              return Promise.all([
                github.repos.createStatus({
                  owner: repository.owner.name,
                  repo: repository.name,
                  sha: commitId,
                  state: "failure",
                  context: STATUS_CONTEXT_PREFIX,
                  description: "Uh-oh!",
                  target_url: pkg.homepage
                }),
                rmDir(repoPath)
              ]).then(cb, cb);
            })
        )
    );
  } catch (error) {
    return callback(null, {
      statusCode: 400,
      headers: { "Content-Type": "text/plain" },
      body: error.toString()
    });
  }
};

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

function gitCommand(
  args,
  options = {
    cwd: REPOS_DIR
  }
) {
  return git.then(() => {
    return new Promise((resolve, reject) => {
      const gitCmd = `git ${args}`;
      console.log(`Command: ${gitCmd}`);
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

function logGitOutput({ stdout, stderr }) {
  console.log(stdout);
  console.warn(stderr);
}

function gitClone(name, cloneUrl) {
  const depth = 50;
  return mkdirp(REPOS_DIR).then(() =>
    gitCommand(`clone --depth=${depth} ${cloneUrl} ${name}`)
  );
}

/**
Before: https://github.com/Glavin001/lambda-github-app.git
After: https://x-access-token:TOKEN@github.com/Glavin001/lambda-github-app.git
*/
function cloneUrlWithToken(cloneUrl, token) {
  return cloneUrl.replace("https://", `https://x-access-token:${token}@`);
}

function gitFetch(remote = "origin", ref, options) {
  return gitCommand(`fetch ${remote} +${ref}`, options);
}

function gitCheckout(commit, options) {
  return gitCommand(`checkout -qf ${commit}`, options);
}

function gitNewBranch(newBranch, options) {
  return gitCommand(`checkout -b ${newBranch}`, options);
}

function gitStatus(options) {
  return gitCommand("status", options);
}

function gitAddAll(options) {
  return gitCommand("add --all", options);
}

function gitCommit(message, options) {
  return gitCommand(`commit --message ${JSON.stringify(message)}`, options);
}

function gitPushAndSetUpstream(branch, remote = "origin", options) {
  return gitCommand(`push --set-upstream ${remote} ${branch}`, options);
}

function gitConfigUser(name, email, options) {
  return gitCommand(`config user.name ${JSON.stringify(name)}`, options).then(
    () => gitCommand(`config user.email ${JSON.stringify(email)}`, options)
  );
}

function gitLogUser(options) {
  return gitCommand("config user.name", options)
    .then(logGitOutput)
    .then(() => gitCommand("config user.email", options))
    .then(logGitOutput);
}
