import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source, so Next must compile them.
  transpilePackages: ['@kult/shared'],
  // The browser bundle must never receive a server secret. Only NEXT_PUBLIC_*
  // values are exposed, and both of these are public by design: the Privy app
  // ID is a publishable identifier, and the API URL is a public endpoint.
  env: {},
  typescript: { ignoreBuildErrors: false },
  poweredByHeader: false,
};

export default config;
