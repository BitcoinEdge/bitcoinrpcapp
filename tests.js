/* global describe it */
/* eslint import/no-extraneous-dependencies: 0 */
/* eslint no-console: 0 */
/* eslint no-unused-expressions: 0 */

const deasync = require('deasync');
const chai = require('chai');
const async = require('async');
const { Node, BitcoinNet, Transaction, BitcoinGraph } = require('bitcointest');
const API = require('./api');
const bitcoin = require('./bitcoin');
const db = require('./db');
const scanner = require('./scanner');
const payment = require('./payment');

const expect = chai.expect;

const INVOICE_CONTENT = 'Test content';

let net;
let graph;
let nodes;
let grp1;
let grp2;
let n1;
let n2;
let n3;
let n4;

let runtask1 = true;
let runtask2 = true;
let runtask3 = true;
let runall = true;

if (process.env.TASK) {
  runall = runtask1 = runtask2 = runtask3 = false;
  const t = process.env.TASK;
  if (''+t === '1') runtask1 = true;
  else if (''+t === '2') runtask2 = true;
  else if (''+t === '3') runtask3 = true;
  else {
    console.log(`unknown task id ${t}; expected 1, 2, or 3; falling back to regular execution`);
    runall = runtask1 = runtask2 = runtask3 = true;
  }
}

const verbose = process.env.V === '1';
const log = verbose ? (...args) => console.log(...args) : (...args) => {};
const bcgraph = verbose ? (g1, g2) => graph.printBlockChainsS(g1, g2) : (g1, g2) => {};
BitcoinNet.setVerbose(verbose);

const waitS = deasync((time, cb) => setTimeout(cb, time));

const finalize = (err, done) => {
  if (err) {
    console.log(`err=${JSON.stringify(err)}`);
    graph.printConnectionMatrix(net.nodes);
    graph.printBlockChainsS(grp1, grp2);
    expect(err).to.be.null;
    done();
  } else {
    expect(err).to.be.null;
    done();
  }
};

const historyString = (history) => {
  let s = '\n';
  for (const h of history) {
    s += `\tinvoice=${h.invoice}; payment=${h.payment}; what(action=${h.what.action}): ${h.content}\n`;
  }
  return s;
};

const actionExistsInHistory = (history, action) => {
  for (const h of history) {
    if (h.what && h.what.action === action) return true;
  }
  return false;
};

const orderedActionsInHistory = (history, actions, historyStart = 0) => {
  let actionIter = 0;
  // console.log(`checking ${historyString(history)} for ordered actions
  //   ${JSON.stringify(actions)}`);
  for (let i = historyStart; i < history.length; i++) {
    let h = history[i];
    const a = actions[actionIter];
    if (Array.isArray(a)) {
      // any order resolution
      // console.log(`any order: ${JSON.stringify(a)}`);
      while (a.length > 0) {
        // console.log(`- i=${i}: alternatives=${JSON.stringify(a)}`);
        let found = false;
        let aindex = -1;
        for (const aa of a) {
          aindex++;
          // console.log(`- checking ${h.what ? h.what.action : null} vs ${aa}`);
          if (h.what && h.what.action == aa) {
            found = true;
            a.splice(aindex, 1);
            // console.log(`- poppped ${aa} -> ${JSON.stringify(a)}`);
            if (a.length === 0) {
              actionIter++;
              if (actionIter === actions.length) return true;
            }
            break;
          }
        }
        // console.log(`- looped; a.length = ${a.length}`);
        if (a.length === 0) break;
        i++;
        if (i >= history.length) return false;
        h = history[i];
      }
      // console.log(`- continuing`);
      continue;
    }
    // console.log(`got ${JSON.stringify(h.what)}; expecting action ${a}`);
    if (h.what && h.what.action === a) {
      actionIter++;
      // console.log(`actionIter++ = ${actionIter}; aiming for ${actions.length}`);
      if (actionIter === actions.length) return true;
    }
  }
  // console.log(`exhausted history with actionIter = ${actionIter}; FAILURE`);
  return false;
};

describe('db', () => {
  it('can be connected to', (done) => {
    db.connect((err) => {
      expect(err).to.be.null;
      done();
    });
  });
})

describe('bitcoind', () => {
  it('can be found', (done) => {
      const which = require('which');
      which('bitcoind', (whichErr, whichPath) => {
        which('Bitcoin-Qt', (whichErrQT, whichPathQT) => {
            const bitcoinPath =
              process.env.BITCOIN_PATH ||
              (!whichErr && whichPath
                ? whichPath.substr(0, whichPath.length - 8)
                : (!whichErrQT && whichPathQT
                   ? whichPathQT.substr(0, whichPathQT.length - 10)
                   : '../bitcoin/src/'));
             net = new BitcoinNet(bitcoinPath, '/tmp/bitcointest/', 22001, 22002);
             graph = new BitcoinGraph(net);
             // TODO: below checks absolutely nothing
             expect(net).to.not.be.null;
             done();
        });
      });
  });
});

let bitcointestOK = false;

describe('bitcointest', () => {
  it('configures', function(done) {
    this.timeout(50000);
    nodes = net.launchBatchS(4);
    expect(nodes.length).to.equal(4);
    [ n1, n2, n3, n4 ] = nodes;
    net.waitForNodesS(nodes, 50000);
    net.connectNodesS(nodes);
    bitcointestOK = true;
    done();
  });

  it('works', function(done) {
    if (!bitcointestOK) {
      console.log('\n\n*** ERROR : bitcoind cannot be started!\n*** ERROR : please do:\n         killall -9 bitcoind\n*** ERROR : and try again!\n\n'.red);
      process.exit(1);
    }
    done();
  });
});


//==============================================================================
//==============================================================================
//==============================================================================

// BLOCKS: none
// LAYOUT: all nodes connected

describe('utxo generation', () => {
  it('obtains spendable outputs', function(done) {
    // switch to one of our nodes, rather than the default one
    bitcoin.switchNode(nodes[0]);
    this.timeout(10000);
    nodes[0].generateBlocksS(1);
    const blocks = nodes[1].generateBlocksS(110);
    net.syncS(net.nodes);
    API.waitForChangeS(blocks[109], 10000);
    const balance = nodes[1].getBalanceS();
    expect(balance).to.be.above(1);
    done();
  });
});

if (runtask1 || runall)
describe('invoice', function() {
  it('can be created', function(done) {
    this.timeout(20000);
    const result = API.createS(1.0, INVOICE_CONTENT);
    expect(result).to.exist;
    expect(result.insertedIds).to.exist;
    expect(result.insertedIds.length).to.equal(1);
    const [ invoiceid ] = result.insertedIds;
    expect(invoiceid).to.exist;
    const { invoice, state } = API.infoS(invoiceid);
    expect(invoice).to.exist;
    expect(state).to.exist;
    expect(invoice.addr).to.exist;
    expect(typeof(invoice.addr)).to.equal('string');
    const addrinfo = bitcoin.validateAddressS(invoice.addr).result;
    expect(addrinfo).to.exist;
    expect(addrinfo.isvalid);
    expect(addrinfo.ismine);
    expect(addrinfo.pubkey).to.exist;
    done();
  });
});

if (runtask2 || runall)
describe('payment', function() {
  let invoiceid;
  let txid;
  // confirmations < 6のpaymentはpendingである
  it('updates status to pending', function(done) {
    this.timeout(20000);
    net.partitionS(nodes, 2);
    const result = API.createS(1, INVOICE_CONTENT);
    invoiceid = result.insertedIds[0];
    const startingInvoice = API.infoS(invoiceid).invoice;
    txid = n2.sendToAddressS(startingInvoice.addr, 1);
    const blocks = n2.generateBlocksS(1);
    API.waitForChangeS(blocks[0], 15000);
    const { invoice, state } = API.infoS(invoiceid);
    expect(state.payments.length).to.be.equal(1);
    const [ payment ] = state.payments;
    expect(payment.status).to.equal('pending');
    done();
  });

  // confirmations >= 6のpaymentはconfirmedである
  it('updates status to confirmed', function(done) {
    this.timeout(20000);
    const blocks = n2.generateBlocksS(5);
    API.waitForChangeS(blocks[4], 15000);
    const { invoice, state } = API.infoS(invoiceid);
    expect(state.payments.length).to.be.equal(1);
    const [ payment ] = state.payments;
    expect(payment.status).to.equal('confirmed');
    done();
  });

  let inState;

  // Payment that is dropped from the Block is changed into Reorg status
  it('updates status to reorg', function(done) {
    this.timeout(20000);
    const blocks = n3.generateBlocksS(7);
    net.mergeS(nodes);
    API.waitForChangeS(blocks[6], 15000);
    const { invoice, state } = API.infoS(invoiceid);
    inState = state;
    expect(state.payments.length).to.be.equal(1);
    const [ payment ] = state.payments;
    expect(payment.status).to.equal('reorg');
    const history = API.historyS(invoiceid);
    lastHistory = history;
    found = orderedActionsInHistory(history, ['create', 'receive', 'reorg']);
    expect(found).to.be.true;
    done();
  });

  it('sets disabledAmount for reorg', function(done) {
    // amounts are slightly off sometimes (e.g. by 1 satoshi)
    expect(inState.disabledAmount).to.be.above( 90000000);
    expect(inState.disabledAmount).to.be.below(110000000);
    done();
  });

  // When returning to the blockchain, becomes pending
  it('restores status to pending', function(done) {
    this.timeout(20000);
    const blocks = n2.generateBlocksS(1);
    API.waitForChangeS(blocks[1], 15000);
    const { invoice, state } = API.infoS(invoiceid);
    expect(state.payments.length).to.be.equal(1);
    const [ payment ] = state.payments;
    expect(payment.status).to.equal('pending');
    done();
  });

  // When confirmations >= 6, become confirmed again
  it('restores status to confirmed', function(done) {
    this.timeout(20000);
    const blocks = n2.generateBlocksS(5);
    API.waitForChangeS(blocks[5], 15000);
    const { invoice, state } = API.infoS(invoiceid);
    expect(state.payments.length).to.be.equal(1);
    const [ payment ] = state.payments;
    expect(payment.status).to.equal('confirmed');
    done();
  });
});

if (runtask3 || runall) {
describe('invoice status', function() {
  const make_and_pay = (self, invamount, payments, blockgen = 1) => {
    self.timeout(20000);
    const result = API.createS(invamount, INVOICE_CONTENT);
    const [ invoiceid ] = result.insertedIds;
    invoice = API.infoS(invoiceid).invoice;
    for (const p of payments)
      n2.sendToAddressS(invoice.addr, p);
    const blocks = n2.generateBlocksS(blockgen);
    API.waitForChangeS(blocks[blockgen-1], 15000);
    return API.infoS(invoiceid).invoice;
  };
  let invoice;
  it('is unpaid', function(done) {
    invoice = make_and_pay(this, 1, [], 6);
    expect(invoice.status).to.be.equal('unpaid');
    done();
  });
  it('becomes paid', function(done) {
    invoice = make_and_pay(this, 1, [1], 6);
    expect(invoice.status).to.be.equal('paid');
    done();
  });
  it('becomes overpaid', function(done) {
    invoice = make_and_pay(this, 1, [1.1], 6);
    expect(invoice.status).to.be.equal('overpaid');
    done();
  });
  it('becomes pending_overpaid', function(done) {
    invoice = make_and_pay(this, 1, [1.1]);
    expect(invoice.status).to.be.equal('pending_overpaid');
    done();
  });
  it('becomes pending_paid', function(done) {
    invoice = make_and_pay(this, 1, [1]);
    expect(invoice.status).to.be.equal('pending_paid');
    done();
  });
  it('becomes partial', function(done) {
    invoice = make_and_pay(this, 1, [0.5], 6);
    expect(invoice.status).to.be.equal('partial');
    done();
  });
  it('becomes pending_partial', function(done) {
    invoice = make_and_pay(this, 1, [0.5]);
    expect(invoice.status).to.be.equal('pending_partial');
    done();
  });
});

let invoice1;

describe('reorg unconfirm then reconfirm into another block:', function() {
  it('partitions', (done) => {
    const nodeGroups = net.partitionS(nodes, 2);
    expect(nodeGroups.length).to.equal(2);
    [ grp1, grp2 ] = nodeGroups;
    done();
  });

  it('can create an invoice', function(done) {
    const result = API.createS(1, INVOICE_CONTENT);
    expect(result).to.not.be.null;
    expect(result.insertedIds).to.not.be.null;
    expect(result.insertedIds.length).to.equal(1);
    [ invoice1 ] = result.insertedIds;
    const history = API.historyS(invoice1);
    expect(actionExistsInHistory(history, 'create')).to.be.true;
    done();
  });

  it('can pay an invoice', function(done) {
    this.timeout(20000);
    const { invoice, state } = API.infoS(invoice1);
    expect(invoice).to.exist;
    expect(state).to.exist;
    expect(invoice.addr).to.exist;
    log(`[PAY ${invoice.addr} from node 2]`);
    const txid = n2.sendToAddressS(invoice.addr, 1);
    expect(txid).to.exist;
    expect(Array.isArray(txid)).to.be.false;
    expect(n1.isConnected(n2, true)).to.be.true;
    const result = n1.waitForTransactionS(txid, 15000);
    if (!result) {
      finalize('result is false', () => done());
    } else {
      expect(result).to.not.be.false;
      done();
    }
  });

  it('populates history with observed transaction', function(done) {
    this.timeout(15000);
    log('[GENERATE blocks on node 1]');
    const blocks = n1.generateBlocksS(6);
    expect(blocks.length).to.equal(6);
    log('block chain after generation (n1,n2   n3,n4):');
    bcgraph(grp1, grp2);
    net.syncS([n1, n2]);
    API.waitForChangeS(blocks[5], 10000);
    // HISTORY: invoice1, <some payment>, { action: 'receive' }
    const history = API.historyS(invoice1);
    log(`history = ${historyString(history)}`);
    expect(orderedActionsInHistory(history, ['create', 'receive'])).to.be.true;
    API.waitForStatusS(invoice1, 'paid');
    n3.generateBlocksS(6);
    waitS(1000);
    log('block chain after n3.generateBlocks (n1,n2   n3,n4):');
    bcgraph(grp1, grp2);
    done();
  });

  it('puts payment as unconfirmed after reorg', function(done) {
    this.timeout(12000);
    log('[Reconnect partitions]');
    const nodes = net.mergeS(net.nodes);
    log('[GENERATE block on node 3 to trigger reorg.  Payment should now be unconfirmed.]');
    const blocks = n3.generateBlocksS(1);
    net.syncS(net.nodes);
    API.waitForChangeS(blocks[0], 6000);
    // HISTORY: invoice1, <same payment>, { action: 'adjust' }
    log('block chain after merge + n3.generateBlocks (n1,n2   n3,n4):');
    bcgraph(grp1, grp2);
    const { invoice, state } = API.infoS(invoice1);
    // the invoice should be unpaid again
    log(`this should be unpaid again:\ninvoice = ${JSON.stringify(invoice)}\nstate = ${JSON.stringify(state)}`);
    const { payments } = state;
    expect(payments.length).to.equal(1);
    expect(invoice.status).to.equal('unpaid');
    const history = API.historyS(invoice1);
    if (!orderedActionsInHistory(history, ['create', 'receive', 'reorg'])) {
      console.log(`history failure (create, receive, reorg): ${historyString(history)}`);
    }
    expect(orderedActionsInHistory(history, ['create', 'receive', 'reorg'])).to.be.true;
    done();
  });

  it('detects reconfirm', function(done) {
    this.timeout(10000);
    log('[GENERATE block on node 1 to reconfirm transaction.]');
    const blocks = n1.generateBlocksS(6);
    net.syncS(net.nodes);
    API.waitForChangeS(blocks[5], 2000);
    const { invoice, state } = API.infoS(invoice1);
    // the invoice should have seen a reorg, but it should now be properly paid
    const { payments } = state;
    expect(payments.length).to.equal(1);
    expect(invoice.status).to.equal('paid');
    done();
  });
});

let invoice2;

describe('double spend (replace payment to other address)', () => {
  it('partitions', (done) => {
    const nodeGroups = net.partitionS(nodes, 2);
    expect(nodeGroups.length).to.equal(2);
    [ grp1, grp2 ] = nodeGroups;
    [ n1, n2 ] = grp1;
    [ n3, n4 ] = grp2;
    log('block chain after partitioning (n1,n2   n3,n4):');
    bcgraph(grp1, grp2);
    done();
  });

  it('submits invoice', (done) => {
    const result = API.createS(1, INVOICE_CONTENT);
    expect(result).to.not.be.null;
    expect(result.insertedIds).to.not.be.null;
    expect(result.insertedIds.length).to.equal(1);
    [ invoice2 ] = result.insertedIds;
    waitS(250);
    const history = API.historyS(invoice2);
    log(`expect 'create' in history = ${historyString(history)}`);
    expect(actionExistsInHistory(history, 'create')).to.be.true;
    done();
  });

  it('pays invoice', function(done) {
    this.timeout(30000);
    const utxo = n2.findSpendableOutputS(1);
    expect(utxo).to.exist;
    expect(utxo.amount).to.be.above(0.99);
    const { invoice, state } = API.infoS(invoice2);
    expect(invoice).to.exist;
    expect(state).to.exist;
    expect(invoice.addr).to.exist;
    log(`[PAY ${invoice.addr} from node 2]`);
    const txid = n2.spendUTXOS(utxo, invoice.addr, 1);
    expect(txid).to.exist;
    log(`- payment txid = ${txid}`);
    expect(n1.isConnected(n2, true)).to.be.true;
    const result = n1.waitForTransactionS(txid, 20000);
    if (!result) {
      finalize('!result', () => {
        expect(result).to.not.be.false;
        n2.shareAddressWithNodeS(n3, utxo.address, true);
      });
    } else {
      expect(result).to.not.be.false;
      n2.shareAddressWithNodeS(n3, utxo.address, true);
    }
    const selfAddr = n3.getNewAddressS();
    log('[Double Spend from node 3]');
    const txid2 = n3.spendUTXOS(utxo, selfAddr, 1);
    log(`- double spend txid = ${txid2}`);
    done();
  });

  // at this point, we have two partitions (n1-n2, n3-n4), where the former
  // group thinks the transaction has gone to the invoice address, and the
  // latter group thinks it's been sent to n3's own address
  // i.e. a double spend to two separate addresses
  // NOTE: the rpc-cli API is hooked up to n1, so it thinks the invoice has been
  // paid at this point

  it('populates history with observed transaction', function(done) {
    this.timeout(20000);
    log('[GENERATE six blocks on node 1]');
    const blocks = n1.generateBlocksS(6);
    net.syncS([n1, n2]);
    API.waitForChangeS(blocks[5], 10000);
    log('block chain after gen (n1,n2   n3,n4):');
    bcgraph(grp1, grp2);
    // HISTORY: invoice2, <some payment>, { action: 'receive' }
    const history = API.historyS(invoice2);
    expect(orderedActionsInHistory(history, ['create', 'receive'])).to.be.true;
    API.waitForStatusS(invoice2, 'paid');
    done();
  });

  it('detects double spend', function(done) {
    this.timeout(30000);
    log('[GENERATE six blocks on node 4]');
    const blocks = n4.generateBlocksS(6);
    net.syncS([n3, n4]);
    log('block chain after partitioned gen (n1,n2   n3,n4):');
    bcgraph(grp1, grp2);
    log('[Reconnect partitions]');
    net.mergeS(net.nodes);
    log('[GENERATE block on node 4 to trigger reorg]');
    n4.generateBlocksS(1);
    net.syncS(net.nodes);
    API.waitForChangeS(blocks[0], 10000);
    log('block chain after n4 gen (n1,n2   n3,n4):');
    bcgraph(grp1, grp2);
    let found = false;
    let lastHistory = null;
    const expiry = new Date().getTime() + 3000;
    while (!found && expiry > new Date().getTime()) {
      const history = API.historyS(invoice2);
      lastHistory = history;
      found = orderedActionsInHistory(history, ['create', 'receive', 'reorg']);
      if (!found) {
        try {
          API.waitForChangeS(invoice2, 'reorg');
        } catch (e) {
          // ignore errors; probably timeout anyway
        }
      }
    }
    expect(found).to.be.true;
    log(`expect create, receive, reorg in ${historyString(lastHistory)}`);
    expect(orderedActionsInHistory(lastHistory, ['create', 'receive', 'reorg'])).to.be.true;
    // also expect history to not be bloated
    expect(lastHistory.length < 6); // create, receive, adjust, reorg, with room for a few others if they ever occur
    log('block chain after n1.generateBlocks (n1,n2   n3,n4):');
    bcgraph(grp1, grp2);
    done();
  });
});

let invoice3;

describe('double spend replace (payment to same address)', () => {
  it('partitions', (done) => {
    const nodeGroups = net.partitionS(nodes, 2);
    expect(nodeGroups.length).to.equal(2);
    [ grp1, grp2 ] = nodeGroups;
    [ n1, n2 ] = grp1;
    [ n3, n4 ] = grp2;
    done();
  });

  it('submits invoice', (done) => {
    const result = API.createS(1, INVOICE_CONTENT);
    expect(result).to.not.be.null;
    expect(result.insertedIds).to.not.be.null;
    expect(result.insertedIds.length).to.equal(1);
    [ invoice3 ] = result.insertedIds;
    waitS(250);
    const history = API.historyS(invoice3);
    log(`expect 'create' in history = ${historyString(history)}`);
    expect(actionExistsInHistory(history, 'create')).to.be.true;
    done();
  });

  let firsttx;
  let secondtx;

  it('pays invoice', function(done) {
    this.timeout(40000);
    const utxo = n2.findSpendableOutputS(1);
    expect(utxo).to.exist;
    expect(utxo.amount).to.be.above(0.99);
    const { invoice, state } = API.infoS(invoice3);
    expect(invoice).to.exist;
    expect(state).to.exist;
    expect(invoice.addr).to.exist;
    log(`[PAY ${invoice.addr} from node 2]`);
    const txid = firsttx = n2.spendUTXOS(utxo, invoice.addr, 1);
    expect(txid).to.exist;
    log(`- payment txid = ${txid}`);
    expect(n1.isConnected(n2, true)).to.be.true;
    n2.generateBlocksS(1);
    const result = n1.waitForTransactionS(txid, 5000);
    if (!result) {
      finalize('!result', () => {
        expect(result).to.not.be.false;
      });
    } else {
      expect(result).to.not.be.false;
    }
    n2.shareAddressWithNodeS(n3, utxo.address, true);
    log('[Double Spend from node 3]');
    const txid2 = secondtx = n3.spendUTXOS(utxo, invoice.addr, 1);
    log(`- double spend txid = ${txid2}`);
    expect(n3.isConnected(n4, true)).to.be.true;
    const result2 = n4.waitForTransactionS(txid2, 15000);
    log(`- n4.waitForTX(${txid2}) = ${result2}`);
    if (!result2) {
      finalize('!result', () => {
        expect(result2).to.not.be.false;
      });
    } else {
      expect(result2).to.not.be.false;
    }
    done();
  });

  it('populates history with observed transaction', function(done) {
    this.timeout(20000);
    log('[GENERATE six blocks on node 1]');
    const blocks = n1.generateBlocksS(5);
    net.syncS([n1, n2]);
    API.waitForChangeS(blocks[4], 10000);
    log('block chain after gen (n1,n2   n3,n4):');
    bcgraph(grp1, grp2);
    // HISTORY: invoice3, <some payment>, { action: 'receive' }
    const history = API.historyS(invoice3);
    expect(orderedActionsInHistory(history, ['create', 'receive'])).to.be.true;
    API.waitForStatusS(invoice3, 'paid');
    done();
  });

  it('detects double spend', function(done) {
    this.timeout(30000);
    log('[GENERATE six blocks on node 4]');
    const blocks = n4.generateBlocksS(6);
    net.syncS([n3, n4]);
    log('block chain after partitioned gen (n1,n2   n3,n4):');
    bcgraph(grp1, grp2);
    log('[Reconnect partitions]');
    net.mergeS(net.nodes);
    log('[GENERATE block on node 4 to trigger reorg]');
    n4.generateBlocksS(1);
    // try {
    //   const stxi = n4.getTransactionS(secondtx, true);
    //   log(`stxi=${JSON.stringify(stxi)}`);
    // } catch (e) {
    //   log('*** n4 does NOOOOOOT know about tx2!!!!');
    //   throw e;
    // }
    net.syncS(net.nodes);
    log(`Waiting for second tx ${secondtx}`)
    const result = n1.waitForTransactionS(secondtx, 15000);
    expect(result).to.not.be.false;
    API.waitForChangeS(blocks[5], 10000);
    // console.log(`first transaction ${firsttx} state:`);
    // try {
    //   console.log(JSON.stringify(bitcoin.getTransactionS(firsttx)));
    // } catch(e) {
    //   console.log('[unavailable]');
    // }
    log('block chain after n4 gen (n1,n2   n3,n4):');
    bcgraph(grp1, grp2);
    let found = false;
    let lastHistory = null;
    const expiry = new Date().getTime() + 3000;
    while (!found && expiry > new Date().getTime()) {
      const history = API.historyS(invoice3);
      lastHistory = history;
      found = orderedActionsInHistory(history, ['create', 'receive', ['receive', 'reorg']]);
      if (!found) {
        try {
          API.waitForChangeS(invoice3, 'receive');
        } catch (e) {
          // ignore errors; probably timeout anyway
        }
      }
    }
    if (!found) {
      console.log(`not found; history = ${historyString(lastHistory)}`);
      const { invoice, state } = API.infoS(invoice3);
      for (const payment of state.payments) {
        console.log(`- payment ${payment._id} [${payment.txid}]: ${payment.amount} (${payment.status})`);
      }
      console.log(`first transaction ${firsttx} state:`);
      try {
        console.log(JSON.stringify(bitcoin.getTransactionS(firsttx)));
      } catch(e) {
        console.log('[unavailable]');
      }
      console.log(`second transaction ${secondtx} state:`);
      try {
        console.log(JSON.stringify(bitcoin.getTransactionS(secondtx)));
      } catch(e) {
        console.log('[unavailable]');
      }
    }
    expect(found).to.be.true;
    log(`expect create, receive, reorg, receive in ${historyString(lastHistory)}`);
    expect(orderedActionsInHistory(lastHistory, ['create', 'receive', ['receive', 'reorg']])).to.be.true;
    // also expect history to not be bloated
    expect(lastHistory.length < 7); // create, receive, adjust, reorg, receive, with room for a few others if they ever occur
    log('block chain after n1.generateBlocks (n1,n2   n3,n4):');
    bcgraph(grp1, grp2);
    // finally expect invoice to be in 'paid' state
    const { invoice, state } = API.infoS(invoice3);
    expect(invoice.status).to.be.equal('paid');
    done();
  });
});

} // if (runtask3 || runall)

//==============================================================================
//==============================================================================
//==============================================================================

describe('cleanup', () => {
  let invoices = null;
  it('finds relevant invoices', (done) => {
    db.find('invoice', { content: INVOICE_CONTENT }, false, (err, invoiceList) => {
      expect(err).to.be.null;
      invoices = invoiceList;
      done();
    });
  });

  it('clears relevant payments', (done) => {
    async.eachSeries(
      invoices,
      (invoice, asyncCallback) => db.remove('payment', { invoice: '' + invoice._id }, (err) => {
        expect(err).to.be.null;
        asyncCallback();
      }),
      done
    );
  });

  it('clears relevant history', (done) => {
    async.eachSeries(
      invoices,
      (invoice, asyncCallback) => db.remove('history', { invoice: '' + invoice._id }, (err) => {
        expect(err).to.be.null;
        asyncCallback();
      }),
      done
    );
  });

  it('clears relevant invoices', (done) => {
    db.remove('invoice', { content: INVOICE_CONTENT }, (err) => {
      expect(err).to.be.null;
      done();
    });
  });
});

describe('bctest end', () => {
  it('shuts down', function(done) {
    this.timeout(6000);
    net.shutdown(() => {
      for (const n of net.nodes) {
        expect(n.running).to.be.false;
      }
      done();
    });
  });
});
