import { Router, type IRouter } from "express";
import authRouter from "./auth";
import healthRouter from "./health";
import v1Router from "./v1";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use("/v1", v1Router);

export default router;
