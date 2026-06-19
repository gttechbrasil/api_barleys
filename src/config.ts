import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3333),
  apiKey: required("API_KEY"),
  // Default webhook URL used when a session is created without its own webhookUrl
  webhookUrl: process.env.WEBHOOK_URL,
  webhookSecret: required("WEBHOOK_SECRET"),
};
