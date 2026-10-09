import { createLogger } from "../../../../src/worker/common/logger";
import type { SecurityEnv } from "./env";

/** Sends a plain-text message; returns false when delivery is unconfigured or fails. */
export async function sendEmail(
  env: SecurityEnv,
  message: { to: string; subject: string; text: string }
): Promise<boolean> {
  if (!env.EMAIL || !env.EMAIL_FROM) return false;
  try {
    await env.EMAIL.send({
      to: message.to,
      from: { email: env.EMAIL_FROM, name: "GitEdge" },
      subject: message.subject,
      text: message.text,
    });
    return true;
  } catch (cause) {
    createLogger(env.LOG_LEVEL, { service: "auth" }).error("email:send-failed", {
      reason: cause instanceof Error ? cause.name : "unknown",
    });
    return false;
  }
}

export function verificationMessage(link: string): { subject: string; text: string } {
  return {
    subject: "Verify your GitEdge email / 验证你的 GitEdge 邮箱",
    text: `Open this link to verify your email address. It expires in 24 hours.\n${link}\n\n打开此链接以验证你的邮箱地址，24 小时内有效。\n\nIf you did not request this, ignore this message. / 如果这不是你的操作，请忽略此邮件。`,
  };
}

export function resetMessage(link: string): { subject: string; text: string } {
  return {
    subject: "Reset your GitEdge password / 重置你的 GitEdge 密码",
    text: `Open this link to choose a new password. It expires in 30 minutes and works once.\n${link}\n\n打开此链接以设置新密码，30 分钟内有效且仅可使用一次。\n\nIf you did not request this, ignore this message. / 如果这不是你的操作，请忽略此邮件。`,
  };
}
