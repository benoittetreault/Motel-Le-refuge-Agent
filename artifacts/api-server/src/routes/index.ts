import { Router, type IRouter } from "express";
import healthRouter from "./health";
import anthropicRouter from "./anthropic";
import bookingsRouter from "./bookings";
import voiceRouter from "./voice";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/anthropic", anthropicRouter);
router.use("/voice", voiceRouter);
router.use(bookingsRouter);

export default router;
