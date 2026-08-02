import { pgEnum } from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", [
  "owner",
  "admin",
  "sales_manager",
  "sales_rep",
  "inspector",
  "production",
  "office",
  "viewer",
]);

export const leadStatusEnum = pgEnum("lead_status", [
  "new",
  "ai_qualified",
  "contact_attempted",
  "inspection_scheduled",
  "inspection_completed",
  "estimate_preparing",
  "estimate_sent",
  "claim_pending",
  "follow_up",
  "won",
  "production_scheduled",
  "in_progress",
  "final_walkthrough",
  "completed",
  "review_requested",
  "nurture",
  "lost",
]);

export const urgencyEnum = pgEnum("urgency", [
  "low",
  "normal",
  "high",
  "emergency",
]);

export const taskStatusEnum = pgEnum("task_status", [
  "open",
  "in_progress",
  "done",
  "cancelled",
]);

export const appointmentTypeEnum = pgEnum("appointment_type", [
  "inspection",
  "estimate_review",
  "production",
  "final_walkthrough",
  "other",
]);

export const appointmentStatusEnum = pgEnum("appointment_status", [
  "scheduled",
  "confirmed",
  "completed",
  "cancelled",
  "no_show",
]);

export const estimateStatusEnum = pgEnum("estimate_status", [
  "draft",
  "sent",
  "accepted",
  "declined",
]);

export const projectStatusEnum = pgEnum("project_status", [
  "scheduled",
  "in_progress",
  "on_hold",
  "completed",
  "cancelled",
]);

export const consentChannelEnum = pgEnum("consent_channel", [
  "sms",
  "email",
  "phone",
]);

export const messageChannelEnum = pgEnum("message_channel", ["email", "sms"]);

export const conversationStatusEnum = pgEnum("conversation_status", [
  "active",
  "completed",
  "abandoned",
]);

export const conversationRoleEnum = pgEnum("conversation_role", [
  "user",
  "assistant",
  "system",
]);

export const automationRunStatusEnum = pgEnum("automation_run_status", [
  "success",
  "partial",
  "failed",
  "skipped",
]);

export const scheduledActionStatusEnum = pgEnum("scheduled_action_status", [
  "pending",
  "done",
  "failed",
  "cancelled",
]);

export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", [
  "pending",
  "success",
  "failed",
]);

export type UserRole = (typeof userRoleEnum.enumValues)[number];
export type LeadStatus = (typeof leadStatusEnum.enumValues)[number];
export type Urgency = (typeof urgencyEnum.enumValues)[number];
