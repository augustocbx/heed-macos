import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MeetingDetectionSettings } from "./MeetingDetectionSettings";
const mock = vi.hoisted(() => ({status:vi.fn(), configure:vi.fn(), authorize:vi.fn()}));
vi.mock("@/api/meeting-detection", () => ({MEETING_APPS:["slack","zoom","teams","meet"], meetingDetectionApi:mock}));
vi.mock("@/api/permissions", () => ({permissionsApi:mock}));
const base = {enabled:{slack:true,zoom:false,teams:false,meet:false}, sources:[], ownerMeetingId:null, error:null};
beforeEach(() => { mock.status.mockResolvedValue(base); mock.configure.mockResolvedValue({...base, enabled:{...base.enabled, zoom:true}}); });
afterEach(() => {cleanup(); vi.clearAllMocks();});
it("configures apps independently and never presents enabled as validated detection", async () => {
 render(<MeetingDetectionSettings/>);
 const zoom = await screen.findByRole("checkbox", {name:"Zoom"});
 expect(zoom).not.toBeChecked(); expect(screen.getAllByText("Not checked")).toHaveLength(1);
 fireEvent.click(zoom); await waitFor(() => expect(mock.configure).toHaveBeenCalledWith({zoom:true}));
 await waitFor(() => expect(zoom).toBeChecked()); expect(screen.getAllByText("Not checked")).toHaveLength(2);
 expect(screen.getByText(/Missing controls or permission never prove/)).toBeVisible();
});
it("shows denied/changed format, manual-stop suppression and save failure without changing settings", async () => {
 mock.status.mockResolvedValue({...base, enabled:{...base.enabled,zoom:true}, sources:[{app:"zoom",detectorId:"native:zoom",state:"unknown",capability:"permission-required",suppressed:false},{app:"slack",detectorId:"native:slack",state:"active",capability:"ready",suppressed:true}]});
 mock.configure.mockRejectedValue(new Error("failed"));
 render(<MeetingDetectionSettings/>);
 expect(await screen.findByText("Accessibility permission needed")).toBeVisible(); expect(screen.getByText("Paused for this call")).toBeVisible();
 fireEvent.click(screen.getByRole("checkbox",{name:"Zoom"})); expect(await screen.findByRole("alert")).toHaveTextContent("Could not save meeting detection settings."); expect(screen.getByRole("checkbox",{name:"Zoom"})).toBeChecked();
});
