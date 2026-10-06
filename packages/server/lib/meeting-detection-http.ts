import { desktopRequestAllowed } from "./desktop-permissions";
import { MeetingDetectionController, parseMeetingReport } from "./meeting-detection";

export async function meetingDetectionRoute(req: Request, controller: MeetingDetectionController, port: string | number): Promise<Response> {
 if (!desktopRequestAllowed(req, port)) return Response.json({error:"Meeting detection is available only from the local Heed interface."}, {status:403});
 const path = new URL(req.url).pathname;
 if (path === "/api/meeting-detection/status") return req.method === "GET" ? Response.json(controller.status()) : Response.json({error:"Method not allowed."}, {status:405});
 if (!["/api/meeting-detection/report", "/api/meeting-detection/settings"].includes(path)) return Response.json({error:"Unknown meeting detection endpoint."}, {status:404});
 if (req.method !== "POST") return Response.json({error:"Method not allowed."}, {status:405});
 try {
  const body = await req.text();
  if (body.length > 4096) return Response.json({error:"Meeting observation is too large."}, {status:413});
  const value = JSON.parse(body);
  if (path.endsWith("/settings")) return Response.json(controller.configure(value));
  if (!controller.report(parseMeetingReport(value))) return Response.json({error:"Stale meeting observation."}, {status:409});
  return Response.json(controller.status());
 } catch (e) { return Response.json({error:e instanceof SyntaxError ? "Invalid meeting observation." : e instanceof Error ? e.message : "Meeting detection failed."}, {status:400}); }
}
