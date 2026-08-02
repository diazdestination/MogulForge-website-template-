import {
  CreateContactBody,
  CreatePropertyBody,
  UpdateContactBody,
  UpdatePropertyBody,
} from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import * as crm from "../../services/crm";

const router: IRouter = Router();

function parsePageNumber(value: unknown): number | undefined {
  return typeof value === "string" && value !== "" ? Number(value) : undefined;
}

router.get(
  "/contacts",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const search =
      typeof req.query.search === "string" ? req.query.search : undefined;
    res.json(
      await crm.listContacts(req.member!.organizationId, search, {
        limit: parsePageNumber(req.query.limit),
        offset: parsePageNumber(req.query.offset),
      }),
    );
  },
);

router.post(
  "/contacts",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateContactBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid contact" });
      return;
    }
    const contact = await crm.createContact(
      req.member!.organizationId,
      parsed.data,
    );
    res.status(201).json(contact);
  },
);

router.get(
  "/contacts/:id",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const contact = await crm.getContact(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }
    res.json(contact);
  },
);

router.patch(
  "/contacts/:id",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateContactBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid contact update" });
      return;
    }
    const contact = await crm.updateContact(
      req.member!.organizationId,
      String(req.params.id),
      parsed.data as Record<string, never>,
    );
    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }
    res.json(contact);
  },
);

router.delete(
  "/contacts/:id",
  requireMember("crm.delete"),
  async (req: Request, res: Response): Promise<void> => {
    const deleted = await crm.deleteContact(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (!deleted) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "contact.deleted",
      entityType: "contact",
      entityId: String(req.params.id),
    });
    res.status(204).end();
  },
);

// ---------- properties ----------

router.get(
  "/properties",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const contactId =
      typeof req.query.contactId === "string" ? req.query.contactId : undefined;
    res.json(
      await crm.listProperties(req.member!.organizationId, contactId, {
        limit: parsePageNumber(req.query.limit),
        offset: parsePageNumber(req.query.offset),
      }),
    );
  },
);

router.post(
  "/properties",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreatePropertyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid property" });
      return;
    }
    const property = await crm.createProperty(
      req.member!.organizationId,
      parsed.data,
    );
    if (!property) {
      res.status(400).json({ error: "Related record not found in your organization" });
      return;
    }
    res.status(201).json(property);
  },
);

router.get(
  "/properties/:id",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const property = await crm.getProperty(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (!property) {
      res.status(404).json({ error: "Property not found" });
      return;
    }
    res.json(property);
  },
);

router.patch(
  "/properties/:id",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdatePropertyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid property update" });
      return;
    }
    const property = await crm.updateProperty(
      req.member!.organizationId,
      String(req.params.id),
      parsed.data as Record<string, never>,
    );
    if (!property) {
      res.status(404).json({ error: "Property not found" });
      return;
    }
    res.json(property);
  },
);

export default router;
