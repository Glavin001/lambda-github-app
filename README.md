# lambda-github-app

GitHub App powered by AWS Lambda 

## Installation

1) Create a new GitHub App: https://github.com/settings/apps/new
  - Use a temporary Webhook URL
  - Remember your Webhook secret
2) Download your GitHub App Private Key (i.e. `.pem` file)
3) Configure this project
  - Move `.pem` into this project and change `CERT` variable from `serverless.yml` if required
  - Change `APP_ID` to match your new GitHub App
  - Change `GITHUB_WEBHOOK_SECRET` to match your new GitHub App
4) Deploy this project. Check out https://serverless.com/framework/docs/getting-started/ for details.
5) Update your GitHub App's Webhook URL
