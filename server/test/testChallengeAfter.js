const CryptoCards = artifacts.require("CryptoCards");
const RootChain = artifacts.require("RootChain");

const SparseMerkleTree = require('./SparseMerkleTree.js');

import {increaseTimeTo, duration} from './helpers/increaseTime'
import assertRevert from './helpers/assertRevert.js';

const UTXO = require('./UTXO.js')

const Promisify = (inner) =>
new Promise((resolve, reject) =>
        inner((err, res) => {
            if (err) {
                reject(err);
            } else {
                resolve(res);
            }
        })
);

contract("Plasma ERC721 - Exit Spent Coin Challenge / `challengeAfter`", async function(accounts) {

    const UTXO_SLOT = 2;
    const t1 = 3600 * 24 * 3; // 3 days later
    const t2 = 3600 * 24 * 5; // 5 days later

    // Alice registers and has 5 coins, and she deposits 3 of them.
    const ALICE_INITIAL_COINS = 5;
    const ALICE_DEPOSITED_COINS = 3;

    let cards;
    let plasma;
    let t0;

    let [authority, alice, bob, charlie, dylan, elliot, random_guy, random_guy2, challenger] = accounts;

    let data;
    let to_alice = [];

    beforeEach(async function() {
        plasma = await RootChain.new({from: authority});
        cards = await CryptoCards.new(plasma.address);
        plasma.setCryptoCards(cards.address);
        cards.register({from: alice});
        assert.equal(await cards.balanceOf.call(alice), 5);


        let ret;
        for (let i = 0; i < ALICE_DEPOSITED_COINS; i ++) {
            ret = UTXO.createUTXO(i, 0, alice, alice); data = ret[0];
            await cards.depositToPlasmaWithData(i+1, data, {from: alice});
            to_alice.push(ret);
        }


        assert.equal((await cards.balanceOf.call(alice)).toNumber(), ALICE_INITIAL_COINS - ALICE_DEPOSITED_COINS);
        assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), ALICE_DEPOSITED_COINS);

        const depositEvent = plasma.Deposit({}, {fromBlock: 0, toBlock: 'latest'});
        const events = await Promisify(cb => depositEvent.get(cb));

        // Check that events were emitted properly
        let coin;
        for (let i = 0; i < events.length; i++) {
            coin = events[i].args;
            assert.equal(coin.slot.toNumber(), i);
            assert.equal(coin.depositBlockNumber.toNumber(), i+1);
            assert.equal(coin.denomination.toNumber(), 1);
            assert.equal(coin.from, alice);
        }

    });

    describe('Invalid Exit of UTXO 2', function() {
        it("Charlie tries to exit a spent coin. Dylan challenges in time and exits his coin", async function() {
            let ret = await charlieExitSpentCoin();

            let to_dylan = ret[0];
            let dylan_tree = ret[1];

            let to_charlie = ret[2];
            let tree_charlie = ret[3];

            let block_number = 3000; // dylan's TX was included in block 3000

            // Challenge the `Exit Spent Coin`
            let challengeTx = to_dylan[0];
            let proof = dylan_tree.createMerkleProof(UTXO_SLOT);
            await plasma.challengeAfter(
                UTXO_SLOT, block_number, challengeTx, proof,
                {'from': challenger, 'value': web3.toWei(0.1, 'ether')}
            );
            t0 = (await web3.eth.getBlock('latest')).timestamp;

            await increaseTimeTo( t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2 });
            // The exit was deleted so Charlie is not able to withdraw the coin
            assertRevert( plasma.withdraw(UTXO_SLOT, {from : charlie }));

            // Dylan will exit his coin now. This is the same as the cooperative exit case
            let prev_tx_proof = tree_charlie.createMerkleProof(UTXO_SLOT)
            let prev_tx = to_charlie[0];
            let exiting_tx = to_dylan[0];
            let sigs = to_charlie[1] + to_dylan[1].replace('0x', '');

            plasma.startExit(
                    UTXO_SLOT,
                    prev_tx, exiting_tx, // rlp encoded
                    prev_tx_proof, proof, // proofs from the tree
                    sigs, // concatenated signatures
                    2000, 3000, // 1000 is when alice->bob got included, 2000 for bob->charlie
                     {'from': dylan, 'value': web3.toWei(0.1, 'ether')}
            );
            t0 = (await web3.eth.getBlock('latest')).timestamp;

            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2 });
            await plasma.withdraw(UTXO_SLOT, {from : dylan });

            assert.equal((await cards.balanceOf.call(alice)).toNumber(), 2);
            assert.equal((await cards.balanceOf.call(bob)).toNumber(), 0);
            assert.equal((await cards.balanceOf.call(charlie)).toNumber(), 0);
            assert.equal((await cards.balanceOf.call(dylan)).toNumber(), 1);
            assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 2);

            // On the contrary, his bond must be slashed, and `challenger` must be able to claim it
            await plasma.withdrawBonds({from: challenger });
            let withdrewBonds = plasma.WithdrewBonds({}, {fromBlock: 0, toBlock: 'latest'});
            let e = await Promisify(cb => withdrewBonds.get(cb));
            let withdraw = e[0].args;
            assert.equal(withdraw.from, challenger);
            // 0.1 ether from the invalid exit and another 0.1 for getting back his challenge bond
            assert.equal(withdraw.amount, web3.toWei(0.2, 'ether')); 

        });

        it("Charlie tries to exit a spent coin. Dylan does not challenge in time", async function() {
            await charlieExitSpentCoin();
            t0 = (await web3.eth.getBlock('latest')).timestamp;
            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2 });

            // Charlie successfully stole Dylan's coin since noone challenged
            plasma.withdraw(UTXO_SLOT, {from : charlie });

            assert.equal((await cards.balanceOf.call(alice)).toNumber(), 2);
            assert.equal((await cards.balanceOf.call(bob)).toNumber(), 0);
            assert.equal((await cards.balanceOf.call(charlie)).toNumber(), 1);
            assert.equal((await cards.balanceOf.call(dylan)).toNumber(), 0);
            assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 2);

            // On the contrary, his bond must be slashed, and `challenger` must be able to claim it
            await plasma.withdrawBonds({from: charlie });

            let withdrewBonds = plasma.WithdrewBonds({}, {fromBlock: 0, toBlock: 'latest'});
            let e = await Promisify(cb => withdrewBonds.get(cb));
            let withdraw = e[0].args;
            assert.equal(withdraw.from, charlie);
            assert.equal(withdraw.amount, web3.toWei(0.1, 'ether'));
        });

        async function charlieExitSpentCoin() {
            let UTXO_SLOT = 2;

            let to_bob = UTXO.createUTXO(UTXO_SLOT, 3, alice, bob);
            let txs = [ to_bob[2] ]
            let tree_bob = await UTXO.submitTransactions(authority, plasma, txs);

            // Tx to Charlie from Bob referencing Bob's UTXO at block 1000
            let to_charlie = UTXO.createUTXO(UTXO_SLOT, 1000, bob, charlie);
            txs = [ to_charlie[2] ]
            let tree_charlie = await UTXO.submitTransactions(authority, plasma, txs);

            // Tx to Dylan from Charlie referencing Charlie's UTXO at block 2000
            let to_dylan = UTXO.createUTXO(UTXO_SLOT, 2000, charlie, dylan);
            txs = [ to_dylan[2] ]
            let tree_dylan = await UTXO.submitTransactions(authority, plasma, txs);

            // Concatenate the 2 signatures
            let sigs = to_bob[1] + to_charlie[1].replace('0x', '');

            let prev_tx_proof = tree_bob.createMerkleProof(UTXO_SLOT)
            let exiting_tx_proof = tree_charlie.createMerkleProof(UTXO_SLOT)

            let prev_tx = to_bob[0];
            let exiting_tx = to_charlie[0];

            plasma.startExit(
                    UTXO_SLOT,
                    prev_tx, exiting_tx, 
                    prev_tx_proof, exiting_tx_proof, 
                    sigs, 
                    1000, 2000, 
                     {'from': charlie, 'value': web3.toWei(0.1, 'ether')}
            );

            return [to_dylan, tree_dylan, to_charlie, tree_charlie];
        }
    })

    describe('Invalid Exit of UTXO 0', function() {
        it("Alice gives a coin to Bob and Charlie and immediately tries to exit Bob's coin. Gets Challenged.", async function() {
            let to_bob = UTXO.createUTXO(1, 2, alice, bob);
            let to_charlie = UTXO.createUTXO(0, 1, alice, charlie);
            let txs = [ to_bob[2], to_charlie[2] ]
            let tree = await UTXO.submitTransactions(authority, plasma, txs);

            let ret = UTXO.createUTXO(1, 0, alice, alice);
            let utxo = ret[0];
            let sig = ret[1];

            await plasma.startExit(
                     1,
                    '0x', utxo,
                    '0x0', '0x0', 
                     sig,
                     0, 2,
                     {'from': alice, 'value': web3.toWei(0.1, 'ether')}
            );

            let challengeTx = to_bob[0];
            let proof = tree.createMerkleProof(1);
            await plasma.challengeAfter(
                1, 1000, challengeTx, proof,
                {'from': challenger, 'value': web3.toWei(0.1, 'ether')}
            );
            t0 = (await web3.eth.getBlock('latest')).timestamp;
            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2 });
            assertRevert(plasma.withdraw(1, {from : alice }));
            assert.equal((await cards.balanceOf.call(alice)).toNumber(), 2);
            assert.equal((await cards.balanceOf.call(bob)).toNumber(), 0);
            assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 3);

            await plasma.withdrawBonds({from: challenger });

            let withdrewBonds = plasma.WithdrewBonds({}, {fromBlock: 0, toBlock: 'latest'});
            let e = await Promisify(cb => withdrewBonds.get(cb));
            let withdraw = e[0].args;
            assert.equal(withdraw.from, challenger);
            assert.equal(withdraw.amount, web3.toWei(0.2, 'ether'));
        });

        it("Alice gives a coin to Bob and Charlie. Bob gives a coin to Charlie and immediately tries to exit it. Gets Challenged", async function() {
            let to_bob = UTXO.createUTXO(0, 1, alice, bob);
            let alice_to_charlie = UTXO.createUTXO(1, 2, alice, charlie);
            let txs = [ to_bob[2], alice_to_charlie[2] ]
            let tree1 = await UTXO.submitTransactions(authority, plasma, txs);

            let bob_to_charlie = UTXO.createUTXO(0, 1000, bob, charlie);
            txs = [ bob_to_charlie[2] ];
            let tree2 = await UTXO.submitTransactions(authority, plasma, txs);

            let sigs = to_alice[0][1] + to_bob[1].replace('0x','');
            let exiting_tx_proof = tree1.createMerkleProof(0);

            let prev_tx = to_alice[0][0];
            let exiting_tx = to_bob[0];
            await plasma.startExit(
                     0,
                     prev_tx, exiting_tx,
                     '0x0', exiting_tx_proof, 
                     sigs,
                     1, 1000,
                     {'from': bob, 'value': web3.toWei(0.1, 'ether')}
            );

            let challengeTx = bob_to_charlie[0];
            let proof = tree2.createMerkleProof(0);
            await plasma.challengeAfter(
                0, 2000, challengeTx, proof,
                {'from': challenger, 'value': web3.toWei(0.1, 'ether')}
            );

            t0 = (await web3.eth.getBlock('latest')).timestamp;
            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2 });
            assertRevert(plasma.withdraw(0, {from : bob }));

            assert.equal((await cards.balanceOf.call(alice)).toNumber(), 2);
            assert.equal((await cards.balanceOf.call(bob)).toNumber(), 0);
            assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 3);

            await plasma.withdrawBonds({from: challenger });

            let withdrewBonds = plasma.WithdrewBonds({}, {fromBlock: 0, toBlock: 'latest'});
            let e = await Promisify(cb => withdrewBonds.get(cb));
            let withdraw = e[0].args;
            assert.equal(withdraw.from, challenger);
            assert.equal(withdraw.amount, web3.toWei(0.2, 'ether'));
        });
    });
});
