/**
 * Provider adapters. Mocks are clearly labeled and used only when real
 * credentials are absent. Real providers (Gmail via Replit connector,
 * Twilio for SMS, Resend for email) activate automatically when their
 * secrets/connections are present.
 */

export interface AiProvider {
  summarizeLead(input: {
    description?: string;
    intent: string;
    urgency: string;
  }): Promise<{ summary: string; provider: string }>;
  /**
   * Internal sales summary for the CRM from a concierge conversation.
   * Must never guarantee insurance approval, pricing, damage conclusions,
   * or structural safety — enforced downstream by guardrails regardless of
   * provider output.
   */
  generateSalesSummary(input: {
    intent?: string;
    urgency: string;
    facts: string[];
    transcript: { role: string; content: string }[];
  }): Promise<{ summary: string; provider: string }>;
}

export interface SmsProvider {
  send(to: string, body: string): Promise<{ id: string; provider: string }>;
}

export interface EmailProvider {
  send(
    to: string,
    subject: string,
    body: string,
  ): Promise<{ id: string; provider: string }>;
}

export interface StormEvent {
  type: 'hail' | 'wind';
  severity: 'minor' | 'moderate' | 'severe';
  /** e.g. hail size in inches or wind gust in mph. */
  magnitude: string;
  distanceMiles: number;
  date: string;
}

export interface WeatherProvider {
  recentStormActivity(postalCode: string): Promise<{
    hasRecentStorm: boolean;
    provider: string;
  }>;
  stormEventsNear(address: string): Promise<{
    events: StormEvent[];
    /** True when the data is demonstration data, not a real weather feed. */
    isDemoData: boolean;
    provider: string;
  }>;
}

export const mockAiProvider: AiProvider = {
  async summarizeLead(input) {
    return {
      summary: `[MOCK AI] ${input.intent} request, urgency ${input.urgency}.${
        input.description ? ` Homeowner notes: ${input.description.slice(0, 200)}` : ""
      }`,
      provider: "mock-ai",
    };
  },
  async generateSalesSummary(input) {
    const lines = [
      `[MOCK AI] Concierge intake — ${input.intent ?? "intent not yet identified"}, urgency ${input.urgency}.`,
      ...input.facts.map((f) => `• ${f}`),
      "Next step: schedule a professional on-site inspection to verify condition (no damage or pricing conclusions from chat).",
    ];
    return { summary: lines.join("\n"), provider: "mock-ai" };
  },
};

/**
 * Real OpenAI provider behind the same interface. Used automatically when
 * OPENAI_API_KEY is present; the concierge engine falls back to the mock
 * provider (with a logged warning) if a call fails so public chat never
 * breaks on provider outages.
 */
export const openAiProvider: AiProvider = {
  async summarizeLead(input) {
    const summary = await openAiComplete(
      "Write a one-sentence internal CRM summary of this inbound sales lead. Do not speculate about damage, pricing, or insurance outcomes.",
      `Intent: ${input.intent}\nUrgency: ${input.urgency}\nHomeowner notes: ${input.description ?? "none"}`,
    );
    return { summary, provider: "openai" };
  },
  async generateSalesSummary(input) {
    const summary = await openAiComplete(
      [
        "You write concise internal sales summaries for a company CRM from AI concierge chat intakes.",
        "Rules: never guarantee insurance approval or claim payment, never state pricing, never conclude the property is damaged or structurally safe/unsafe — only report what the customer said.",
        "Always end with the recommended next step for the sales rep.",
        "Output 4-7 short lines.",
      ].join(" "),
      [
        `Intent: ${input.intent ?? "unknown"}`,
        `Urgency: ${input.urgency}`,
        `Known facts:\n${input.facts.map((f) => `- ${f}`).join("\n")}`,
        `Transcript:\n${input.transcript
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n")
          .slice(0, 6000)}`,
      ].join("\n\n"),
    );
    return { summary, provider: "openai" };
  },
};
export const mockSmsProvider: SmsProvider = {
  async send(to, body) {
    // Dev visibility: mock sends are logged so flows (e.g. portal login
    // codes) can be exercised without a real SMS provider.
    console.log(`[MOCK SMS] to=${to} body=${body}`);
    return { id: `mock-sms-${Date.now()}`, provider: "mock-sms" };
  },
};

export const mockEmailProvider: EmailProvider = {
  async send(to, subject, body) {
    console.log(`[MOCK EMAIL] to=${to} subject=${subject} body=${body}`);
    return { id: `mock-email-${Date.now()}`, provider: "mock-email" };
  },
};

/**
 * Real SMS via the Twilio REST API. Selected automatically when
 * TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER are set.
 * Fails loudly (throws) so automation runs record the failure instead of
 * silently pretending a message was delivered.
 */
export const twilioSmsProvider: SmsProvider = {
  async send(to, body) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER;
    if (!sid || !token || !from) {
      throw new Error("Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER)");
    }
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
      },
    );
    if (!res.ok) {
      throw new Error(`Twilio send failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { sid?: string };
    if (!data.sid) throw new Error("Twilio returned no message SID");
    return { id: data.sid, provider: "twilio" };
  },
};
/**
 * Real email provider that sends through the owner's connected Gmail account
 * via the Replit Gmail connector. Used automatically when the connector
 * environment is present (see `emailProvider` below). Errors propagate so a
 * failed send is recorded as a failure — never silently mocked.
 */
export const gmailEmailProvider: EmailProvider = {
  async send(to, subject, body) {
    // Header-injection guard: the recipient is interpolated into a raw
    // RFC 2822 header, so reject anything that isn't a plain mailbox.
    if (!isSafeMailbox(to)) {
      throw new Error("Refusing to send email: invalid recipient address");
    }
    const { ReplitConnectors } = await import("@replit/connectors-sdk");
    // Never cache the client — tokens expire; the SDK refreshes per instance.
    const connectors = new ReplitConnectors();
    // RFC 2822 message. Subject is encoded so punctuation/unicode survive.
    const message = [
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      body,
    ].join("\r\n");
    const raw = Buffer.from(message, "utf8").toString("base64url");
    const res = await connectors.proxy(
      "google-mail",
      "/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw }),
      },
    );
    if (!res.ok) {
      throw new Error(`Gmail send failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { id?: string };
    return { id: data.id ?? "unknown", provider: "gmail" };
  },
};

/**
 * True when the Gmail connector runtime is available (Replit injects these
 * env vars when a connection is attached). Falls back to the mock provider
 * otherwise so local/dev flows stay deterministic.
 */
/**
 * Strict single-mailbox check used before interpolating a recipient into a
 * raw RFC 2822 header. Rejects CR/LF, whitespace, commas, and angle brackets
 * so a stored value can never smuggle additional headers or recipients.
 */
export function isSafeMailbox(to: string): boolean {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(to);
}

/**
 * Reports which email provider automations will use right now, and (for
 * Gmail) which account the messages are sent from. Used by the settings UI
 * so admins can see the actual sending identity. Never throws — a profile
 * lookup failure still reports the active provider with a null sender.
 */
export async function getEmailProviderStatus(): Promise<{
  provider: "gmail" | "resend" | "mock";
  senderEmail: string | null;
}> {
  if (isGmailConfigured()) {
    try {
      const { ReplitConnectors } = await import("@replit/connectors-sdk");
      const connectors = new ReplitConnectors();
      const res = await connectors.proxy(
        "google-mail",
        "/gmail/v1/users/me/profile",
        { method: "GET" },
      );
      if (res.ok) {
        const data = (await res.json()) as { emailAddress?: string };
        return { provider: "gmail", senderEmail: data.emailAddress ?? null };
      }
      console.warn(`[email] Gmail profile lookup failed: ${res.status}`);
    } catch (err) {
      console.warn(
        "[email] Gmail profile lookup failed:",
        err instanceof Error ? err.message : err,
      );
    }
    return { provider: "gmail", senderEmail: null };
  }
  if (process.env.RESEND_API_KEY) {
    return {
      provider: "resend",
      senderEmail:
        process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev",
    };
  }
  return { provider: "mock", senderEmail: null };
}

/**
 * Reports which SMS provider automations will use right now and, for Twilio,
 * the phone number texts are sent from. Used by the settings UI so admins
 * can tell whether customers actually receive texts or sends only hit the
 * dev mock. Checked at call-time so env changes are always reflected.
 */
export function getSmsProviderStatus(): {
  provider: "twilio" | "mock";
  senderPhoneNumber: string | null;
} {
  if (isTwilioConfigured()) {
    return {
      provider: "twilio",
      senderPhoneNumber: process.env.TWILIO_PHONE_NUMBER ?? null,
    };
  }
  return { provider: "mock", senderPhoneNumber: null };
}

export function isTwilioConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_PHONE_NUMBER,
  );
}

export function isGmailConfigured(): boolean {
  return Boolean(
    process.env.REPLIT_CONNECTORS_HOSTNAME &&
      (process.env.REPL_IDENTITY || process.env.WEB_REPL_RENEWAL),
  );
}

/**
 * Real email via the Resend API. Selected automatically when RESEND_API_KEY
 * is set. RESEND_FROM_EMAIL is optional; defaults to Resend's shared
 * onboarding sender (fine for testing, replace with a verified domain
 * sender for production).
 */
export const resendEmailProvider: EmailProvider = {
  async send(to, subject, body) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error("RESEND_API_KEY is not set");
    const from =
      process.env.RESEND_FROM_EMAIL ?? "Leads <onboarding@resend.dev>";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ from, to: [to], subject, text: body }),
    });
    if (!res.ok) {
      throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error("Resend returned no message id");
    return { id: data.id, provider: "resend" };
  },
};
export const mockWeatherProvider: WeatherProvider = {
  async recentStormActivity() {
    return { hasRecentStorm: false, provider: "mock-weather" };
  },
  async stormEventsNear(address) {
    // Deterministic demo data derived from the address so repeat checks are stable.
    let hash = 0;
    for (const ch of address.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const daysAgo = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() - offset);
      return d.toISOString().slice(0, 10);
    };
    const events: StormEvent[] = [
      {
        type: "hail",
        severity: hash % 3 === 0 ? "severe" : "moderate",
        magnitude: hash % 3 === 0 ? '1.75" hail' : '1.0" hail',
        distanceMiles: (hash % 40) / 10 + 0.5,
        date: daysAgo(4 + (hash % 20)),
      },
      {
        type: "wind",
        severity: hash % 2 === 0 ? "moderate" : "minor",
        magnitude: `${45 + (hash % 30)} mph gusts`,
        distanceMiles: (hash % 70) / 10 + 1,
        date: daysAgo(10 + (hash % 30)),
      },
    ];
    return { events, isDemoData: true, provider: "mock-weather" };
  },
};

/**
 * Transcribe a short voice clip with OpenAI. Caller is responsible for
 * validating size/type and checking OPENAI_API_KEY is present.
 */
export async function transcribeAudio(
  audio: Buffer,
  mimeType: string,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const ext = mimeType.includes("webm")
    ? "webm"
    : mimeType.includes("wav")
      ? "wav"
      : mimeType.includes("mpeg")
        ? "mp3"
        : mimeType.includes("3gpp")
          ? "3gp"
          : "m4a";
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(audio)], { type: mimeType }),
    `clip.${ext}`,
  );
  form.append("model", "whisper-1");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`OpenAI transcription failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}
/**
 * Draft one outreach touch (email or SMS body) for a Closer Engine playbook
 * step, personalized from the lead's context. Uses OpenAI when configured;
 * falls back to a clearly-labeled deterministic mock so dev/test flows never
 * depend on the API. Guardrails: never promise pricing, insurance outcomes,
 * or damage conclusions — the message only offers help and next steps.
 */
export async function draftOutreachMessage(input: {
  channel: "email" | "sms";
  prompt: string;
  businessName: string;
  contactFirstName: string;
  leadSummary?: string;
  serviceType?: string;
  urgency: string;
  stepNumber: number;
  totalSteps: number;
}): Promise<{ body: string; provider: string }> {
  if (process.env.OPENAI_API_KEY) {
    try {
      const body = await openAiComplete(
        [
          `You write ${input.channel === "sms" ? "SMS texts (max 2 short sentences, no links, no emojis)" : "short plain-text emails (max 6 short lines, no HTML)"} for ${input.businessName}, reaching out to a customer who requested help.`,
          "Rules: never state pricing, never guarantee insurance approval, never make damage or safety determinations — only offer help and a clear next step.",
          "Address the customer by first name. Sign off with the business name.",
          "Output ONLY the message body.",
        ].join(" "),
        [
          `Customer first name: ${input.contactFirstName}`,
          `Their request: ${input.leadSummary ?? input.serviceType ?? "your request"}`,
          `Urgency: ${input.urgency}`,
          `Touch ${input.stepNumber} of ${input.totalSteps}. Direction for this message: ${input.prompt}`,
        ].join("\n"),
      );
      return { body, provider: "openai" };
    } catch (err) {
      console.warn(
        "[playbooks] OpenAI draft failed, using fallback copy:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  const greeting = `Hi ${input.contactFirstName},`;
  const core =
    input.channel === "sms"
      ? `${input.businessName} here — we're ready to help with your ${input.serviceType ?? "request"}. Reply to this text and we'll take care of the rest.`
      : `${greeting}\n\nThanks for reaching out about your ${input.serviceType ?? "request"} — our team is ready to help and it's easy to schedule time with us. Just reply to this email and we'll set it up.\n\n— ${input.businessName}`;
  return { body: core, provider: "template-fallback" };
}

async function openAiComplete(system: string, user: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 400,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI request failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("OpenAI returned an empty completion");
  return content;
}

const resendConfigured = Boolean(process.env.RESEND_API_KEY);

/**
 * Runtime-adaptive email provider. Selection and failure semantics:
 *
 * - If at least one real provider is configured (Gmail connector or Resend),
 *   real delivery is attempted in order: Gmail → Resend. If every configured
 *   real provider fails, the error from the last one is re-thrown so the
 *   automation run records a true failure (no silent mock fallback that makes
 *   undelivered messages look successful).
 * - If NO real provider is configured, the labeled mock is used and a warning
 *   is logged. This keeps local/dev flows deterministic without crashing.
 *
 * Provider availability is checked at send-time (not module-load) so
 * connector binding state is always current.
 */
export const adaptiveEmailProvider: EmailProvider = {
  async send(to, subject, body) {
    const gmailAvailable = isGmailConfigured();
    // Check Resend availability at call-time (not module-load) so env stubs
    // in tests and runtime changes to RESEND_API_KEY are always honoured.
    const anyRealProvider = gmailAvailable || Boolean(process.env.RESEND_API_KEY);

    if (!anyRealProvider) {
      // No real provider configured — use labeled mock (dev/test only).
      console.warn("[email] No real provider configured — using mock. No email was delivered.");
      return mockEmailProvider.send(to, subject, body);
    }

    let lastError: unknown;

    // 1. Gmail via Replit connector
    if (gmailAvailable) {
      try {
        return await gmailEmailProvider.send(to, subject, body);
      } catch (gmailErr) {
        lastError = gmailErr;
        console.warn(
          "[email] Gmail provider failed, trying Resend:",
          gmailErr instanceof Error ? gmailErr.message : gmailErr,
        );
      }
    }

    // 2. Resend (check env live so test stubs take effect)
    if (process.env.RESEND_API_KEY) {
      try {
        return await resendEmailProvider.send(to, subject, body);
      } catch (resendErr) {
        lastError = resendErr;
        console.error(
          "[email] Resend provider also failed:",
          resendErr instanceof Error ? resendErr.message : resendErr,
        );
      }
    }

    // All configured real providers failed — propagate so the automation run
    // is marked failed, not silently logged as successful.
    throw lastError instanceof Error
      ? lastError
      : new Error("[email] All configured providers failed to send");
  },
};

const twilioConfigured = isTwilioConfigured();

export const providers = {
  // Global default stays the mock provider so existing flows (e.g. public
  // assessment capture) remain deterministic; the concierge opts into the
  // OpenAI provider with an explicit fallback.
  ai: mockAiProvider,
  // Twilio activates automatically when its three secrets are set; mock otherwise.
  sms: twilioConfigured ? twilioSmsProvider : mockSmsProvider,
  // Runtime-adaptive: tries Gmail connector → Resend → mock on every call.
  email: adaptiveEmailProvider,
  weather: mockWeatherProvider,
};
