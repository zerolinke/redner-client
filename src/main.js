const fs = require('fs')

const md5File = require('md5-file')
const axios = require('axios')
const path = require('path')
const moment = require('moment')
const uuid = require('uuid')
const PROTO_PATH = __dirname + '\\..\\protos\\pr_gn.proto';
console.log('PROTO_PATH: ', PROTO_PATH)
const grpc = require('grpc');
const protoLoader = require('@grpc/proto-loader');
const packageDefinition = protoLoader.loadSync(
    PROTO_PATH,
    {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
    });
const pr_proto = grpc.loadPackageDefinition(packageDefinition).pr;

/**
 * Implements the SayHello RPC method.
 */
function sayHello(call, callback) {
    console.log('redner-client sayHello');


    callback(null, {message: 'Hello ' + call.request.message + ' This is redner-client.'});
}

function generate(call, callback) {

}

/**
 * Starts an RPC server that receives requests for the Greeter service at the
 * sample server port
 */
var server = new grpc.Server();
server.addService(pr_proto.Gn.service, {sayHello: sayHello, generate});
server.bind('0.0.0.0:50066', grpc.ServerCredentials.createInsecure());
server.start();
