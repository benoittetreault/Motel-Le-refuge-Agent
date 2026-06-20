import { Router, type IRouter } from "express";
import healthRouter from "./health";
import anthropicRouter from "./anthropic";
import bookingsRouter from "./bookings";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/anthropic", anthropicRouter);
router.use(bookingsRouter);

export default router;
