# Instruction Guide: Adding the Check-Runner Build Stage to Jenkins

This guide walks you through adding a Jenkins pipeline stage that builds the `neurolink-check-runner` Docker image and pushes it to AWS ECR. It assumes you already have a Bitbucket repo with Jenkins wired to it and an existing Jenkinsfile with CI/CD stages.

---

## Prerequisites

- Bitbucket repo that Jenkins is already connected to
- Jenkins job (Pipeline or Multibranch Pipeline) pointing at that repo
- AWS credentials configured in Jenkins (IAM role, credentials plugin, or env vars) for ECR access
- Access to the Neurolink fork and sandbox branch (e.g. `arshkhan-proj/arshkhan-proj-neurolink`, branch `Neurolink-Sandbox`)

---

## Step 1: Understand What the Stage Will Do

The new stage will:

1. Check out (or ensure) the Neurolink repo at the sandbox branch
2. Log into AWS ECR
3. Build the Docker image using `Dockerfile.check-runner`
4. Tag the image with `{ECR_REGISTRY}/{ECR_REPOSITORY}:{commit-hash}-check-runner`
5. Push the image to ECR

---

## Step 2: Ensure Neurolink Has Required Files

In the **Neurolink** repo (your fork, sandbox branch), verify these files exist at the repo root:

| File | Purpose |
|------|---------|
| `Dockerfile.check-runner` | Builds the check-runner image (Node + pnpm + CLI + HTTP API) |
| `run-sandbox-checks.sh` | Script that runs `pnpm lint && pnpm test` inside the container |
| `check-runner.js` | HTTP server exposing `POST /run-checks` |

If missing, add them from the Neurolink repo and commit/push to the sandbox branch.

---

## Step 3: Get ECR and AWS Values From Your Existing Pipeline

Before adding the stage, open your **existing Jenkinsfile** in the Bitbucket repo and note:

- **ECR registry**: e.g. `701342709052.dkr.ecr.ap-south-1.amazonaws.com`
- **ECR repository**: the repo name you use for images (e.g. `neurolink-check-runner` or a shared repo)
- **AWS region**: e.g. `ap-south-1`
- **ECR login command**: how you currently authenticate (often `aws ecr get-login-password ... | docker login ...`)

Reuse these exact values and patterns in the new stage.

---

## Step 4: Decide Where Neurolink Is Checked Out

Two common setups:

### Option A: Same repo is Neurolink

If the Jenkins job checks out the Neurolink repo directly, then `WORKSPACE` is the Neurolink root. No extra clone step needed.

### Option B: This Bitbucket repo is different (e.g. infra/CI repo)

If this repo is **not** Neurolink, the stage must clone Neurolink first. You will need:

- Neurolink repo URL (SSH or HTTPS), e.g.  
  `git@bitbucket.org:your-org/neurolink.git` or  
  `https://github.com/arshkhan-proj/arshkhan-proj-neurolink.git`
- Sandbox branch name, e.g. `Neurolink-Sandbox`
- Jenkins credentials for Git (if private)

---

## Step 5: Add the Stage to Your Jenkinsfile

Open the Jenkinsfile in your Bitbucket repo and add the following **inside** the existing `stages { }` block.

### 5a. Environment variables (if not already defined)

Add or adjust at the pipeline level:

```groovy
environment {
  AWS_DEFAULT_REGION  = 'ap-south-1'                              // your AWS region
  ECR_REGISTRY        = '701342709052.dkr.ecr.ap-south-1.amazonaws.com'  // your ECR registry
  ECR_REPOSITORY      = 'neurolink-check-runner'                  // ECR repo name
}
```

Replace with your actual ECR registry and repository names.

### 5b. The build-and-push stage

```groovy
stage('Build & push neurolink-check-runner') {
  when {
    branch 'Neurolink-Sandbox'   // run only on sandbox branch; change if needed
  }
  steps {
    script {
      sh '''
        set -euo pipefail

        # Navigate to Neurolink root (adjust if you use dir('neurolink') elsewhere)
        cd "${WORKSPACE}"

        # If this repo is NOT Neurolink, clone it first:
        # git clone --branch Neurolink-Sandbox --single-branch <neurolink-repo-url> neurolink
        # cd neurolink

        NEURO_COMMIT=$(git rev-parse --short HEAD)
        IMAGE_TAG="${ECR_REGISTRY}/${ECR_REPOSITORY}:${NEURO_COMMIT}-check-runner"

        echo "Building image: ${IMAGE_TAG}"

        # ECR login (use same pattern as your existing stages)
        aws ecr get-login-password --region ${AWS_DEFAULT_REGION} | \
          docker login --username AWS --password-stdin ${ECR_REGISTRY}

        # Build image
        docker build -t "${IMAGE_TAG}" -f Dockerfile.check-runner .

        # Push to ECR
        docker push "${IMAGE_TAG}"

        echo "Pushed image: ${IMAGE_TAG}"
      '''
    }
  }
}
```

### 5c. If you need to clone Neurolink (Option B)

Uncomment and adjust the clone block inside the `sh`:

```groovy
sh '''
  set -euo pipefail

  # Clone Neurolink sandbox branch
  git clone --branch Neurolink-Sandbox --single-branch \
    git@bitbucket.org:your-org/neurolink.git neurolink
  cd neurolink

  NEURO_COMMIT=$(git rev-parse --short HEAD)
  IMAGE_TAG="${ECR_REGISTRY}/${ECR_REPOSITORY}:${NEURO_COMMIT}-check-runner"
  # ... rest unchanged
'''
```

---

## Step 6: Ensure ECR Repository Exists

If `ECR_REPOSITORY` (e.g. `neurolink-check-runner`) does not exist in ECR yet:

1. AWS Console → ECR → Create repository
2. Name: `neurolink-check-runner` (or whatever you set in `ECR_REPOSITORY`)
3. Or create via CLI:  
   `aws ecr create-repository --repository-name neurolink-check-runner --region ap-south-1`

---

## Step 7: Ensure Jenkins Has Docker and AWS CLI

Your Jenkins agent must have:

- `docker` installed and the Jenkins user allowed to run it
- `aws` CLI installed and configured (via IAM role, env vars, or credentials plugin)

If your existing image-build stages already work, this is already satisfied.

---

## Step 8: Commit, Push, and Run

1. Commit the Jenkinsfile changes to your Bitbucket repo
2. Push to the branch that triggers the pipeline (e.g. `Neurolink-Sandbox` or `main`)
3. In Jenkins, run the pipeline (or let webhook trigger it)
4. Open the build → Console Output and confirm:
   - ECR login succeeds
   - `docker build` runs with `Dockerfile.check-runner`
   - `docker push` succeeds
   - Final log line: `Pushed image: <registry>/<repo>:<commit>-check-runner`

---

## Step 9: Verify the Image in ECR

In AWS Console → ECR → `neurolink-check-runner` (or your repo), you should see an image tagged e.g. `abc1234-check-runner` (commit hash + suffix).

You can pull and run it:

```bash
aws ecr get-login-password --region ap-south-1 | \
  docker login --username AWS --password-stdin 701342709052.dkr.ecr.ap-south-1.amazonaws.com

docker pull 701342709052.dkr.ecr.ap-south-1.amazonaws.com/neurolink-check-runner:<commit>-check-runner

docker run --rm -p 4000:4000 \
  -e CHECK_RUNNER_SECRET=super-secret-token \
  701342709052.dkr.ecr.ap-south-1.amazonaws.com/neurolink-check-runner:<commit>-check-runner
```

Then:

```bash
curl -X POST -H "X-Check-Secret: super-secret-token" http://localhost:4000/run-checks
```

---

## Summary Checklist

- [ ] Neurolink fork has `Dockerfile.check-runner`, `run-sandbox-checks.sh`, `check-runner.js` on sandbox branch
- [ ] ECR repository exists (or will be created)
- [ ] Jenkinsfile has correct `ECR_REGISTRY`, `ECR_REPOSITORY`, `AWS_DEFAULT_REGION`
- [ ] Stage uses the same ECR login pattern as your existing pipeline
- [ ] `cd` path matches where Neurolink code lives (`WORKSPACE` vs `WORKSPACE/neurolink`)
- [ ] Stage is guarded with `when { branch '...' }` if you want it only on sandbox
- [ ] Jenkins agent has `docker` and `aws` CLI
- [ ] Commit, push, run pipeline, and verify image in ECR
