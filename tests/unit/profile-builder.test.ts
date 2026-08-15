import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPublishedProfile,
  derivePrivateRepositoryStack,
  previewReceiverEconomics,
} from "../../packages/cli/dist/commands/profile.js";

test("publishes only independently selected receiver fields", () => {
  const profile = buildPublishedProfile({
    values: {
      coarseLocation: "US Northeast",
      projectDescriptions: ["An agent inbox"],
      publicRepositoryUrls: ["https://github.com/example/public"],
      subscriptionTier: "Pro",
      tokenUsageRange: "100k-500k/month",
    },
    enabled: {
      coarseLocation: false,
      projectDescriptions: true,
      publicRepositoryUrls: true,
      subscriptionTier: false,
      tokenUsageRange: false,
    },
  });

  assert.deepEqual(profile, {
    projectDescriptions: ["An agent inbox"],
    publicRepositoryUrls: ["https://github.com/example/public"],
  });
});

test("private repository inspection returns only allowlisted technologies", () => {
  const result = derivePrivateRepositoryStack({
    repositoryPath: "/Users/alice/secret-project",
    remote: "git@github.com:alice/secret-project.git",
    manifests: {
      "package.json": JSON.stringify({ dependencies: { react: "19", next: "16", pg: "8" } }),
      "requirements.txt": "django==5.0\n# internal-repo-name\n",
    },
  });

  assert.deepEqual(result, ["Django", "Next.js", "Postgres", "React", "TypeScript"]);
  assert.doesNotMatch(JSON.stringify(result), /alice|secret|github|Users|internal/i);
});

test("economics preview separates cash take-home from non-cash offers", () => {
  assert.deepEqual(previewReceiverEconomics({
    acceptedRewardTypes: ["stablecoin", "credits", "discount"],
    minimumTakeHomeMinor: 250,
  }), {
    accepted: ["Stablecoin (cash)", "Product credits", "Discounts"],
    minimumCashTakeHome: "$2.50",
    minimumGrossBidAtLaunchSplit: "$3.13",
    explanation: "Credits and discounts are bonuses and never replace the $2.50 cash minimum.",
  });
});
