import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../types";

const mocks=vi.hoisted(()=>({file:vi.fn(),packages:vi.fn()}));
vi.mock("../../files/jobs/worker-runtime",()=>({dispatchFileJobs:mocks.file}));
vi.mock("./worker-runtime",()=>({dispatchPackageJobs:mocks.packages}));
import { dispatchResearchAndFileJobs } from "./scheduled-runtime";

beforeEach(()=>{mocks.file.mockReset();mocks.packages.mockReset();});
describe("one-action independent research scheduler",()=>{
  it("alternates the existing two-minute slots without executing a second busy queue",async()=>{
    const env={} as Env;
    mocks.packages.mockResolvedValue({jobId:"package",outcome:"file_verified"});
    mocks.file.mockResolvedValue({jobId:"migration",outcome:"copied"});
    expect(await dispatchResearchAndFileJobs(env,240_000)).toEqual({jobId:"package",outcome:"file_verified"});
    expect(mocks.file).not.toHaveBeenCalled();
    expect(await dispatchResearchAndFileJobs(env,360_000)).toEqual({jobId:"migration",outcome:"copied"});
    expect(mocks.packages).toHaveBeenCalledTimes(1);
  });
  it("lets an idle first queue yield its slot and returns the single second action",async()=>{
    mocks.packages.mockResolvedValue({jobId:null,outcome:"idle"});
    mocks.file.mockResolvedValue({jobId:"migration",outcome:"copied"});
    expect(await dispatchResearchAndFileJobs({} as Env,0)).toEqual({jobId:"migration",outcome:"copied"});
    expect(mocks.packages).toHaveBeenCalledTimes(1);expect(mocks.file).toHaveBeenCalledTimes(1);
  });
  it("keeps historical installations with no package schema eligible for FP3 work",async()=>{
    mocks.packages.mockResolvedValue({jobId:null,outcome:"unsupported"});
    mocks.file.mockResolvedValue({jobId:"migration",outcome:"copied"});
    expect(await dispatchResearchAndFileJobs({} as Env,0)).toMatchObject({jobId:"migration"});
  });
  it.each(["disabled","cleaned","paused"])("does not add another action after %s",async outcome=>{
    mocks.packages.mockResolvedValue({jobId:null,outcome});
    expect(await dispatchResearchAndFileJobs({} as Env,0)).toEqual({jobId:null,outcome});
    expect(mocks.file).not.toHaveBeenCalled();
  });
});
