# Deploying Ark on the pai-risk-mlops platform cluster

End-to-end runbook for a first deploy. Mirrors the foundry-service onboarding pattern (`/Users/paytmlabs/Projects/pi-risk-mlops/k8s/infra-applications/foundry-service`). Account `880170353725`, region `ap-south-1`.

## Prerequisites

- AWS CLI logged in: `aws --profile pai-risk-mlops sts get-caller-identity` returns the platform account (`880170353725`).
- `kubectl` context pointed at the pai-risk-mlops EKS cluster (ArgoCD will reconcile, but cluster access helps debugging).
- ECR push permissions for `pai-mlops-platform/ark`.
- RDS master credentials for `foundry.chy2qgkm0yi2.ap-south-1.rds.amazonaws.com` (DBA hands these out).

## Step 1 -- create the `ark` database in the shared foundry RDS

The foundry RDS instance hosts both `foundry` and (after this) `ark` databases. One Postgres process; separate logical DBs so a misbehaving Ark cannot affect foundry.

```sql
-- as the RDS master user
CREATE DATABASE ark;
\c ark
CREATE SCHEMA IF NOT EXISTS code_intel;
GRANT ALL ON DATABASE ark TO foundry_master;  -- or the principal Ark will use
```

Confirm:
```bash
psql -h foundry.chy2qgkm0yi2.ap-south-1.rds.amazonaws.com -U <master> -d ark -c '\dn'
```

## Step 2 -- AWS Secrets Manager: app secrets entry

Create the secret at path `pai-risk-mlops/platform/ark` with these keys (mirrors the `appSecrets` list in `pai-risk-mlops-platform-values.yaml`):

```bash
aws --profile pai-risk-mlops secretsmanager create-secret \
  --name pai-risk-mlops/platform/ark \
  --secret-string '{
    "ANTHROPIC_API_KEY": "...",
    "OPENAI_API_KEY": "...",
    "GOOGLE_API_KEY": "...",
    "SAGE_BEARER_TOKEN": "...",
    "GITHUB_WEBHOOK_SECRET": "...",
    "BITBUCKET_WEBHOOK_SECRET": "...",
    "SLACK_SIGNING_SECRET": "...",
    "LINEAR_WEBHOOK_SECRET": "...",
    "JIRA_WEBHOOK_SECRET": "...",
    "PI_SAGE_WEBHOOK_SECRET": "..."
  }'
```

The RDS-managed secret (`rds!db-9b1f1b3f-...`) already exists -- foundry uses it. Ark's `pai-risk-mlops-platform-values.yaml` references it directly; no work needed.

## Step 3 -- IAM role for IRSA (`platform-ark-service`)

S3 access on `pai-mlops-artifacts-platform/ark/*` + Secrets Manager read on the Ark app secret. Trust policy bound to the cluster's OIDC provider for SA `ark/ark`.

```bash
# Trust policy
cat > /tmp/ark-trust.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::880170353725:oidc-provider/oidc.eks.ap-south-1.amazonaws.com/id/<OIDC-ID>"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "oidc.eks.ap-south-1.amazonaws.com/id/<OIDC-ID>:sub": "system:serviceaccount:ark:ark"
      }
    }
  }]
}
EOF

aws --profile pai-risk-mlops iam create-role \
  --role-name platform-ark-service \
  --assume-role-policy-document file:///tmp/ark-trust.json

# Attach policies (S3 read/write on prefix + Secrets Manager read)
cat > /tmp/ark-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::pai-mlops-artifacts-platform",
        "arn:aws:s3:::pai-mlops-artifacts-platform/ark/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
      "Resource": [
        "arn:aws:secretsmanager:ap-south-1:880170353725:secret:pai-risk-mlops/platform/ark*",
        "arn:aws:secretsmanager:ap-south-1:880170353725:secret:rds!db-9b1f1b3f-*"
      ]
    }
  ]
}
EOF

aws --profile pai-risk-mlops iam put-role-policy \
  --role-name platform-ark-service \
  --policy-name platform-ark-service-policy \
  --policy-document file:///tmp/ark-policy.json
```

OIDC ID lookup (one-time):
```bash
aws --profile pai-risk-mlops eks describe-cluster \
  --name pai-risk-mlops-platform \
  --query 'cluster.identity.oidc.issuer' --output text | sed 's|.*/||'
```

## Step 4 -- build + push the Ark image to ECR

```bash
# Login
aws --profile pai-risk-mlops ecr get-login-password --region ap-south-1 \
  | docker login --username AWS --password-stdin 880170353725.dkr.ecr.ap-south-1.amazonaws.com

# Build
docker build -t ark:latest .

# Tag + push (use a real version tag in production, not `latest`)
docker tag ark:latest 880170353725.dkr.ecr.ap-south-1.amazonaws.com/pai-mlops-platform/ark:latest
docker push 880170353725.dkr.ecr.ap-south-1.amazonaws.com/pai-mlops-platform/ark:latest
```

If the ECR repo doesn't exist:
```bash
aws --profile pai-risk-mlops ecr create-repository \
  --repository-name pai-mlops-platform/ark \
  --region ap-south-1
```

## Step 5 -- wire ArgoCD to deploy this chart

In `/Users/paytmlabs/Projects/pi-risk-mlops/k8s/infra-applications/application-bootstrap/pai-risk-mlops-platform-values.yaml`, add an entry under `deployments.system` (or a new `business` group, your call):

```yaml
    - name: ark
      path: k8s/infra-applications/ark
      namespace: ark
      createNamespace: true
      autosync: true
      selfheal: true
      helm:
        releaseName: ark
        valueFiles: ['pai-risk-mlops-platform-values.yaml']
```

Two ways to source the chart:

**Option A (simpler, recommended for first cut):** mirror our `.infra/helm/ark/` chart into `pi-risk-mlops/k8s/infra-applications/ark/` (copy the directory) and let ArgoCD reconcile from the pi-risk-mlops repo. Same pattern as foundry-service.

**Option B (cleaner long-term):** point the ArgoCD Application at this repo (`bitbucket.org/paytmteam/ark` -- or the GitHub mirror) using `source.repoURL` + `source.path` + `source.targetRevision`. Requires adding the repo as an ArgoCD project source.

Whichever you pick, commit + push to `pi-risk-mlops`. ArgoCD reconciles within a minute.

## Step 6 -- sanity checks after first sync

```bash
# Pods up
kubectl --context pai-risk-mlops-platform -n ark get pods

# Logs
kubectl --context pai-risk-mlops-platform -n ark logs -l app.kubernetes.io/component=control-plane --tail=50

# DB migrations applied
kubectl --context pai-risk-mlops-platform -n ark exec -it deploy/ark-control-plane -- \
  bun packages/cli/index.ts code-intel db status

# Health
curl -k https://ark.internal.ap-south-1.platform.mlops.pai.mypaytm.com/health
```

## Step 7 -- create the first tenant + workspace

```bash
# Inside the control-plane pod (until the bootstrap CLI lands externally)
kubectl --context pai-risk-mlops-platform -n ark exec -it deploy/ark-control-plane -- \
  bun packages/cli/index.ts tenant create paytm --name "Paytm"

kubectl --context pai-risk-mlops-platform -n ark exec -it deploy/ark-control-plane -- \
  bun packages/cli/index.ts workspace create paytm-platform --tenant paytm \
  --name "Paytm Platform Engineering"
```

## Rollback

ArgoCD `Application.spec.source.targetRevision` -- pin to a previous git SHA in the bootstrap, sync, done.

For schema changes that broke things, the `ark code-intel db status` output shows the current migration version; manual `DROP TABLE` is the escape hatch (we are still pre-pilot).

## Outstanding items before going live

- Decide ECR image tag strategy (CI-driven SHA tags, semver, or `latest` -- prefer semver tied to ark Chart.yaml `appVersion`).
- Add a dedicated read-only DB user for Ark instead of using foundry's master via the rotating secret.
- Confirm `ark.internal.ap-south-1.platform.mlops.pai.mypaytm.com` DNS + nginx target-group binding.
- Decide on the bundled vs ElastiCache Redis (bundled is fine for pilot).
- Remote compute targets (Wave 2b-2 in flight) are not yet wired -- workspace dispatch in production lands once that wave completes.
