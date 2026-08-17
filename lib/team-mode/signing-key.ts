/**
 * Deliberately public proof-of-concept key. Anyone with this private repo can
 * forge a team-mode placement, which is acceptable only because team mode has
 * no money, no public deployment, and an additional shared invite key.
 * Production marketplace delivery must never use this key.
 */
export const TEAM_MODE_KEY_ID = "team-poc-v1";

export const TEAM_MODE_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIKLx3YdNA9+eZbOAMiZrXgqvihNPSjWo3gghakkmMrkk
-----END PRIVATE KEY-----
`;

export const TEAM_MODE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAy0JlR7YVygsDrsKh54ukyiEg8FXLEqsj2u81djWjntg=
-----END PUBLIC KEY-----
`;
