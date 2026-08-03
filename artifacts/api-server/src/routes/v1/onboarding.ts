import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import {
  ONBOARDING_STEPS,
  createTestLead,
  deleteTestLeads,
  getOnboardingState,
  updateOnboardingState,
} from "../../services/onboarding";

const router: IRouter = Router();

/** Wizard state + canonical step list (any active member can read it). */
router.get(
  "/onboarding",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const state = await getOnboardingState(req.member!.organizationId);
    res.json({ steps: [...ONBOARDING_STEPS], state });
  },
);

/** Record wizard progress (admins only — it drives org configuration). */
router.patch(
  "/onboarding",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body ?? {};
    const result = await updateOnboardingState(req.member!.organizationId, {
      completeSteps: Array.isArray(body.completeSteps)
        ? body.completeSteps.filter((s: unknown): s is string => typeof s === "string")
        : undefined,
      currentStep: typeof body.currentStep === "string" ? body.currentStep : undefined,
      launched: body.launched === true ? true : undefined,
      dismissed: typeof body.dismissed === "boolean" ? body.dismissed : undefined,
    });
    if ("error" in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ steps: [...ONBOARDING_STEPS], state: result });
  },
);

/** Guided demo: create the sandbox test lead (never contacts anyone real). */
router.post(
  "/onboarding/test-lead",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const result = await createTestLead(req.member!.organizationId);
    res.status(201).json(result);
  },
);

/** Remove the sandbox demo records. */
router.delete(
  "/onboarding/test-lead",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const removed = await deleteTestLeads(req.member!.organizationId);
    res.json({ removed });
  },
);

export default router;
