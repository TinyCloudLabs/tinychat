import {expect,test} from 'bun:test';
import {runFixedScreen} from './meeting-eval.js';

test('fixed screen retains every attempt and scores escaped markers independently of structural coverage',async()=>{
 const report=await runFixedScreen();
 expect(report.attempts).toHaveLength(36);
 expect(report.totals.structuralPasses).toBe(36);
 for(const attempt of report.attempts.filter(a=>a.scenario==='abc-two-parts')){
   expect(attempt.requiredPointRecall.ratio).toBe(1);
   expect(attempt.factualSupport.supported).toBe(true);
   expect(attempt.modelCalls).toBe(1);
 }
 for(const attempt of report.attempts.filter(a=>a.scenario==='abc-omitted-bc-stays-partial')){
   expect(attempt.status).toBe('partial');
   expect(attempt.requiredPointRecall.ratio).toBe(1/3);
   expect(attempt.structuralPass).toBe(true);
 }
 expect(report.totals.cleanCompleted).toBe(12);
 expect(report.totals.internalRecoveries).toBe(6);
 expect(report.totals.userRetries).toBe(0);
});
