import test from 'node:test';
import assert from 'node:assert/strict';
import {planTopup} from '../lib/topup.mjs';
test('monitor needs no ETH reserve when no transfer is needed or no eligible revenue exists',()=>{
 const input={balance:{credit_balance_usdc:'1000000',usdc_available_usdc:'0',pending_deposit_usdc:'0'},policy:{thresholdMicro:'200000',targetMicro:'1000000',maxMicro:'1000000',dailyCapMicro:'1000000',walletReserveMicro:'0',ethReserveWei:'100'},revenueMicro:'0',alreadySentMicro:'0',walletUsdcMicro:'0',sentTodayMicro:'0',ethWei:'0',gasCostWei:'0'};
 assert.equal(planTopup(input).reason,'above-threshold');
 input.balance.credit_balance_usdc='0';assert.equal(planTopup(input).reason,'no-eligible-budget');
 input.revenueMicro='1000';input.walletUsdcMicro='1000';assert.throws(()=>planTopup(input),/ETH gas reserve/);
});
