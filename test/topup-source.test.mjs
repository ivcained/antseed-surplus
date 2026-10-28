import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface} from 'ethers';
import * as topup from '../lib/topup.mjs';
const seller='0x1111111111111111111111111111111111111111';
const buyer='0x2222222222222222222222222222222222222222';
const deposits='0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2';
const channels='0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d';
const erc20=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const ch=new Interface(['event ChannelSettled(bytes32 indexed channelId,address indexed buyer,address indexed seller,uint128 cumulativeAmount,uint128 delta,uint128 totalSettled,uint256 platformFee,bytes metadata)']);
function logs(){return [{address:deposits,...ch.encodeEventLog(ch.getEvent('ChannelSettled'),['0x'+'11'.repeat(32),buyer,seller,100n,100n,100n,4n,'0x'])},{address:topup.USDC,...erc20.encodeEventLog(erc20.getEvent('Transfer'),[deposits,seller,96n])}];}
test('combined Surplus spendable credit must not double count its deposited-USDC component',()=>{
 const input={balance:{credit_balance_usdc:'100000',usdc_available_usdc:'100000',pending_deposit_usdc:'0'},policy:{thresholdMicro:'150000',targetMicro:'200000',maxMicro:'100000',dailyCapMicro:'100000',walletReserveMicro:'0',ethReserveWei:'0'},revenueMicro:'100000',alreadySentMicro:'0',walletUsdcMicro:'100000',sentTodayMicro:'0',ethWei:'100000',gasCostWei:'0'};
 const plan=topup.planTopup(input);assert.equal(plan.effectiveBalanceMicro,'100000');assert.equal(plan.amountMicro,'100000');
});
test('deposit-contract transfers count only with matching canonical ChannelSettled evidence',()=>{
 assert.equal(typeof topup.settlementPayoutMatches,'function');
 const l=logs();assert.equal(topup.settlementPayoutMatches({logs:l},seller,[deposits]),false,'wrong event emitter');
 l[0].address=channels;assert.equal(topup.settlementPayoutMatches({logs:l},seller,[deposits]),true);
 assert.equal(topup.settlementPayoutMatches({logs:[l[1]]},seller,[deposits]),false,'deposit withdrawal is not seller revenue');
 l[1]={address:topup.USDC,...erc20.encodeEventLog(erc20.getEvent('Transfer'),[deposits,seller,100n])};
 assert.equal(topup.settlementPayoutMatches({logs:l},seller,[deposits]),false,'fee must reconcile exactly');
});
