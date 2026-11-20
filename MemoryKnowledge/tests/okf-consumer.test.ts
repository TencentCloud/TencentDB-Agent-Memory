import { describe, expect, it } from "vitest";
import { parseFrontmatter, buildPage, readSources, sourceEntries } from "../src/engines/wiki/ingest-v2/frontmatter.js";
import { readOkfMetadata, OKF_VERSION, OKF_SPEC_COMMIT } from "../src/engines/wiki/okf.js";
describe("OKF frontmatter consumption", () => {
 it("retains unknown types, null extensions and structured provenance", () => {
  const source={resource:"https://example.test/data",id:"evidence",extra:null};
  const parsed=parseFrontmatter(buildPage({type:"Future Type",sources:[source],extension:null},"fact"));
  expect(parsed.frontmatter.type).toBe("Future Type");expect(parsed.frontmatter.extension).toBeNull();expect(parsed.frontmatter.sources).toEqual([source]);
 });
 it("preserves prototype-named extension keys",()=>{
  const extensions=JSON.parse('{"__proto__":{"extension":true},"constructor":"synthetic"}');
  const parsed=parseFrontmatter(buildPage({type:"Metric",...extensions},"fact"));
  expect(Object.hasOwn(parsed.frontmatter,"__proto__")).toBe(true);expect(parsed.frontmatter["__proto__"]).toEqual({extension:true});expect(parsed.frontmatter.constructor).toBe("synthetic");
 });
 it("requires an exact closing delimiter",()=>{
  const text="---\ntype: Metric\n---suffix\nbody";expect(parseFrontmatter(text)).toMatchObject({hasFrontmatter:false,body:text});
 });
 it("rejects sequence frontmatter but retains ordinary body consumption",()=>{
  expect(parseFrontmatter("---\n- type: Metric\n---\nbody")).toMatchObject({hasFrontmatter:false,frontmatter:{type:"other"},body:"body"});
 });
 it("does not coerce an invalid producer type",()=>{
  let n=0;const bad={toString(){n++;throw Error("synthetic");}};
  expect(parseFrontmatter(buildPage({type:bad as unknown as string},"body")).frontmatter.type).toBe("other");expect(n).toBe(0);
 });
 it("accepts EOF/CRLF closing delimiters and keeps legacy raw-source reading",()=>{
  expect(parseFrontmatter("---\r\ntype: Metric\r\n---").hasFrontmatter).toBe(true);
  const text=buildPage({type:"Metric",sources:["legacy.txt",{resource:"https://example.test/legacy.txt"}]},"fact");expect(readSources(text)).toEqual(["legacy.txt"]);expect(sourceEntries(parseFrontmatter(text).frontmatter.sources)).toHaveLength(2);
 });
});
describe("advisory OKF metadata",()=>{
 it("pins the specification and defaults missing optional metadata",()=>{
  expect(OKF_VERSION).toBe("0.2");expect(OKF_SPEC_COMMIT).toBe("ad30107c31c06aec8a7d5636e0d1058118604e6f");
  expect(readOkfMetadata(buildPage({type:"Future Type"},"fact"))).toMatchObject({status:"stable",stale:false,trust:"unverified",verificationPredatesContent:false,warnings:[]});
 });
 it("derives actor tiers and flags verification predating generation",()=>{
  const text=buildPage({type:"Metric",generated:{by:"producer/1",at:"2026-10-12T12:00:00Z"},verified:[{by:"process:check",at:"2026-10-11T12:00:00Z"},{by:"human:synthetic",at:"2026-10-11T14:00:00+02:00"}],stale_after:"2026-10-13T12:00:00+02:00"},"fact");
  const r=readOkfMetadata(text,Date.parse("2026-10-14T00:00:00Z"));expect(r).toMatchObject({trust:"human-reviewed",stale:true,verificationPredatesContent:true});expect(r.frontmatter.verified).toHaveLength(2);
 });
 it("derives a machine tier from a non-human actor assertion",()=>{
  expect(readOkfMetadata(buildPage({type:"Metric",verified:{by:"process:check",at:"2026-10-11T00:00:00Z"}},"fact")).trust).toBe("machine-confirmed");
 });
 it("warns without rejecting malformed optional metadata",()=>{
  const r=readOkfMetadata("---\ntype: Future Type\ngenerated: unknown\nverified: unknown\nstatus: future-state\nstale_after: bad\nsources: invalid\n---\nbody");expect(r.frontmatter.type).toBe("Future Type");expect(r.status).toBe("future-state");expect(r.trust).toBe("unverified");expect(r.warnings).toEqual(expect.arrayContaining(["Invalid source entry","Invalid or empty verified family","Unknown status"]));
 });
 it("warns about duplicate provenance IDs and unmatched inline citations",()=>{
  const r=readOkfMetadata(buildPage({type:"Metric",sources:[{resource:"https://example.test/a",id:"same"},{resource:"https://example.test/b",id:"same"}]},"claim[^missing]"));expect(r.warnings).toContain("Duplicate sources[].id; attribution is ambiguous");expect(r.warnings).toContain("Footnote has no sources[].id: missing");
 });
 it("handles large verification families without exceeding argument limits",()=>{
  const verified=Array.from({length:150_000},()=>({by:"process:synthetic",at:"2026-10-11T00:00:00Z"}));
  const text=buildPage({type:"Metric",generated:{by:"process:producer",at:"2026-10-12T00:00:00Z"},verified},"fact");
  expect(readOkfMetadata(text)).toMatchObject({trust:"machine-confirmed",verificationPredatesContent:true});
 },30_000);
 it("retains computation descriptors as data",()=>{
  const r=readOkfMetadata(buildPage({type:"Attested Computation",runtime:"sh",executor:{entrypoint:"synthetic-command"},attester:{entrypoint:"synthetic-checker"}},"fact"));expect(r.frontmatter.executor).toEqual({entrypoint:"synthetic-command"});expect(r.frontmatter.attester).toEqual({entrypoint:"synthetic-checker"});
 });
});
