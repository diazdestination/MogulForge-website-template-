import { Router, type IRouter } from "express";

import apiKeysRouter from "./api-keys";
import assistantRouter from "./assistant";
import appointmentsRouter from "./appointments";
import automationsRouter from "./automations";
import contactsRouter from "./contacts";
import dashboardRouter from "./dashboard";
import leadsRouter from "./leads";
import meRouter from "./me";
import publicRouter from "./public";
import settingsRouter from "./settings";
import tagsRouter from "./tags";
import tasksRouter from "./tasks";
import templatesRouter from "./templates";
import webhooksRouter from "./webhooks";
import estimatesRouter from "./estimates";
import projectsRouter from "./projects";
import storageRouter from "./storage";
import portalRouter from "./portal";
import googleReviewsRouter from "./google-reviews";

const router: IRouter = Router();

router.use(meRouter);
router.use(contactsRouter);
router.use(leadsRouter);
router.use(estimatesRouter);
router.use(projectsRouter);
router.use(tasksRouter);
router.use(appointmentsRouter);
router.use(dashboardRouter);
router.use(assistantRouter);
router.use(settingsRouter);
router.use(apiKeysRouter);
router.use(templatesRouter);
router.use(automationsRouter);
router.use(webhooksRouter);
router.use(tagsRouter);
router.use(publicRouter);
router.use(storageRouter);
router.use(portalRouter);
router.use(googleReviewsRouter);

export default router;
