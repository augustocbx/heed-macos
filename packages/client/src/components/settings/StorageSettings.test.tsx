import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {useLocaleStore} from '@/stores/locale';
import {tr} from '@/lib/i18n';
import {StorageSettings} from './StorageSettings';
const fixture={limitBytes:2_000_000_000,usedBytes:1000,reservedBytes:100,protectedBytes:500,reclaimableBytes:600,availableBytes:1_999_998_900,categories:{text:200,media:600,indexes:100,staging:100}};
const api=vi.hoisted(()=>({status:vi.fn(),preview:vi.fn(),apply:vi.fn()}));
vi.mock('@/api/storage',()=>({storageApi:api}));
afterEach(()=>{cleanup();useLocaleStore.getState().sync("en");vi.resetAllMocks();});
it('shows authoritative decimal GB and requires reviewed confirmation before removing local media',async()=>{
 api.status.mockResolvedValue(fixture);api.preview.mockResolvedValue({...fixture,requestedLimit:1_000_000_000,removals:[{path:'/synthetic/old.wav',bytes:100}],token:'review'});api.apply.mockResolvedValue({...fixture,limitBytes:1_000_000_000});
 render(<StorageSettings/>);const input=await screen.findByLabelText('Maximum local meeting data (GB)');expect(input).toHaveValue(2);
 fireEvent.change(input,{target:{value:'1'}});fireEvent.click(screen.getByRole('button',{name:'Review change'}));
 expect(await screen.findByText('Review storage change')).toBeInTheDocument();expect(api.apply).not.toHaveBeenCalled();
 expect(screen.getByText(/old.wav/)).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Confirm storage change'}));
 await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('Storage limit saved.'));expect(input).toHaveValue(1);
});
it('rejects invalid values without submitting and preserves the previous limit after blocked reduction',async()=>{
 api.status.mockResolvedValue(fixture);api.preview.mockRejectedValue(new Error('Requested quota is below protected meeting data and reservations'));
 render(<StorageSettings/>);const input=await screen.findByLabelText('Maximum local meeting data (GB)');fireEvent.change(input,{target:{value:'0'}});fireEvent.click(screen.getByRole('button',{name:'Review change'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Choose a storage limit');expect(api.preview).not.toHaveBeenCalled();
 fireEvent.change(input,{target:{value:'1'}});fireEvent.click(screen.getByRole('button',{name:'Review change'}));
 await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Requested quota is below protected meeting data'));expect(api.apply).not.toHaveBeenCalled();
});
it('reset previews the decimal default and allows cancellation without saving',async()=>{
 api.status.mockResolvedValue({...fixture,limitBytes:4_000_000_000});api.preview.mockResolvedValue({...fixture,requestedLimit:2_000_000_000,removals:[],token:'review'});
 render(<StorageSettings/>);await screen.findByLabelText('Maximum local meeting data (GB)');fireEvent.click(screen.getByRole('button',{name:'Reset to 2 GB'}));
 await screen.findByText('Review storage change');fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(api.apply).not.toHaveBeenCalled();expect(screen.queryByText('Review storage change')).not.toBeInTheDocument();
});

it.each(['en','pt-BR','fr','de'] as const)('supports accessible units and localized quota explanations in %s',async(locale)=>{useLocaleStore.getState().sync(locale);api.status.mockResolvedValue(fixture);api.preview.mockRejectedValue(new Error('Requested quota is below protected meeting data and reservations'));render(<StorageSettings/>);const input=await screen.findByLabelText(tr('Maximum local meeting data (GB)'));fireEvent.change(input,{target:{value:'1'}});fireEvent.click(screen.getByRole('button',{name:tr('Review change')}));await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent(tr('Requested quota is below protected meeting data and reservations')));expect(screen.getAllByText(/ GB$/).length).toBeGreaterThan(0);expect(screen.getByRole('button',{name:tr('Reset to 2 GB')})).toBeEnabled();});

const cacheSummary =
  "Local search data ({count} files, {size} GB) will be cleared and can be rebuilt when space is available. This cleanup keeps transcripts and audio.";
const cacheUsage = {
  ...fixture,
  reclaimableBytes: 1_800_000_000,
  reclaimableMediaBytes: 600_000_000,
  reclaimableCacheBytes: 1_200_000_000,
};
it.each(["en", "pt-BR", "fr", "de"] as const)(
  "separates cache-only cleanup from retained media in %s",
  async (locale) => {
    useLocaleStore.getState().sync(locale);
    api.status.mockResolvedValue(cacheUsage);
    api.preview.mockResolvedValue({
      ...cacheUsage,
      requestedLimit: 1_000_000_000,
      removals: [],
      derivedCache: { bytes: 1_200_000_000, files: 3 },
      token: "cache-review",
    });
    render(<StorageSettings />);
    await screen.findByLabelText(tr("Maximum local meeting data (GB)"));
    const format = (bytes: number) =>
      new Intl.NumberFormat(locale, { maximumFractionDigits: 9 }).format(
        bytes / 1_000_000_000,
      );
    expect(
      within(
        screen.getByText(tr("Reclaimable local media")).parentElement!,
      ).getByText(format(600_000_000) + " GB"),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByText(tr("Rebuildable local search data")).parentElement!,
      ).getByText(format(1_200_000_000) + " GB"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: tr("Review change") }));
    expect(
      await screen.findByText(
        tr(cacheSummary, locale, { count: 3, size: format(1_200_000_000) }),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        tr(
          "{count} local media files will be removed. Remote copies and transcripts remain unchanged.",
          locale,
          { count: 0 },
        ),
      ),
    ).toBeInTheDocument();
    if (locale !== "en")
      expect(
        tr(cacheSummary, locale, { count: 3, size: format(1_200_000_000) }),
      ).not.toContain("Local search data");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(api.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: tr("Cancel") }));
    expect(
      screen.queryByText(tr("Review storage change")),
    ).not.toBeInTheDocument();
    expect(api.apply).not.toHaveBeenCalled();
  },
);
it("reviews mixed cleanup with only media filenames and its own media count", async () => {
  api.status.mockResolvedValue(cacheUsage);
  api.preview.mockResolvedValue({
    ...cacheUsage,
    requestedLimit: 1_000_000_000,
    removals: [{ path: "/synthetic/retained-old.wav", bytes: 600_000_000 }],
    derivedCache: { bytes: 1_200_000_000, files: 3 },
    token: "mixed-review",
  });
  api.apply.mockResolvedValue({ ...cacheUsage, limitBytes: 1_000_000_000 });
  render(<StorageSettings />);
  await screen.findByLabelText("Maximum local meeting data (GB)");
  fireEvent.click(screen.getByRole("button", { name: "Review change" }));
  expect(
    await screen.findByText(
      cacheSummary.replace("{count}", "3").replace("{size}", "1.2"),
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      "1 local media files will be removed. Remote copies and transcripts remain unchanged.",
    ),
  ).toBeInTheDocument();
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getByRole("listitem")).toHaveTextContent(
    "retained-old.wav — 0.6 GB",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm storage change" }),
  );
  await screen.findByRole("status");
  expect(api.apply).toHaveBeenCalledWith(1_000_000_000, "mixed-review");
});
it("keeps legacy media-only usage and hides empty search cleanup summaries", async () => {
  api.status.mockResolvedValue(fixture);
  api.preview.mockResolvedValue({
    ...fixture,
    requestedLimit: 2_000_000_000,
    removals: [],
    derivedCache: { bytes: 0, files: 0 },
    token: "no-cleanup",
  });
  render(<StorageSettings />);
  await screen.findByLabelText("Maximum local meeting data (GB)");
  expect(
    within(
      screen.getByText("Reclaimable local media").parentElement!,
    ).getByText("0.0000006 GB"),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("Rebuildable local search data"),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review change" }));
  await screen.findByText("Review storage change");
  expect(screen.queryByText(/Local search data \(/)).not.toBeInTheDocument();
});
