// No value here is a live credential. Most are carried over from an earlier tool's tests (same author); the
// Telegram and Stripe samples follow those services' published documentation examples. Each is assembled at runtime
// so the source never holds a complete key-shaped string for a secret scanner (or GitHub push protection) to flag.
export const j = (...parts: string[]): string => parts.join('');

/** One fake sample per built-in detector, keyed by the mask kind it should produce. */
export const FAKE = {
  PRIVATE_KEY: j('-----BEGIN ', 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END ', 'PRIVATE KEY-----'),
  JWT: j('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiJ0ZXN0LXVzZXIifQ', '.', 'c2lnbmF0dXJlLWZvci10ZXN0cw'),
  ANTHROPIC_KEY: j('sk-ant-', 'api03-', 'Zq8vR2mN7xK4pL9wT3bH6cJ1fD5gA0sE'),
  OPENAI_KEY: j('sk-proj-', 'Qw7Er4Ty1Ui8Op5As2Df9Gh6Jk3Lz0Xc'),
  GITHUB_TOKEN: j('ghp_', 'R4nD0mT0k3nV4lu3F0rT35t1ngPurp0s3s'),
  GITLAB_TOKEN: j('glpat-', 'Xy7Zq2Wm9Rt4Lp8Kd3Vb'),
  SLACK_TOKEN: j('xoxb-', '1234567890-', 'Ab3Cd5Ef7Gh9'),
  AWS_KEY: j('AKIA', 'Z7Q2W9E4R1T8Y5U3'),
  GOOGLE_API_KEY: j('AIza', 'Sy', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'),
  STRIPE_KEY: j('sk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc'),
  NPM_TOKEN: j('npm_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'),
  HUGGINGFACE_TOKEN: j('hf_', 'QwErTy1234UiOpAs5678DfGhJk9012LzXc'),
  SENDGRID_KEY: j('SG.', 'ngeVfQFYQlKU0ufo8x5d1A', '.', 'TwL2iGABf9DHoTf-09kqeF8tAmbihYzrnopKc-1s5cr'),
  DIGITALOCEAN_TOKEN: j('dop_', 'v1_', '0123456789abcdef'.repeat(4)),
  TELEGRAM_BOT_TOKEN: j('123456789', ':', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1'),
  URL_PASSWORD: j('S3cr3t', '-Pa55-', 'w0rd'),
  EMAIL: j('jane.doe', '@', 'example.com'),
  HOME_USER: 'jane',
  // The Visa test number every payment provider publishes; passes the Luhn check.
  CARD_NUMBER: j('4111 ', '1111 ', '1111 ', '1111'),
  CARD_NUMBER_JSON: j('4111', '1111', '1111', '1111'),
} as const;

/** Text a sample needs around it to be detected, for kinds that mask only part of what they match. */
export const AROUND: Partial<Record<keyof typeof FAKE, readonly [string, string]>> = {
  URL_PASSWORD: ['postgres://app:', '@db.internal:5432/prod'],
  HOME_USER: ['(/Users/', '/projects/app/index.js:3:9)'],
  CARD_NUMBER_JSON: ['{"id":', '}'],
};

/** The quote `scrub` writes on both sides of a kind's placeholder, for kinds whose value it turns into a JSON string. */
export const WRAPPED: Partial<Record<keyof typeof FAKE, string>> = { CARD_NUMBER_JSON: '"' };
