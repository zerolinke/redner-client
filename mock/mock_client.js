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


function main() {
    var client = new pr_proto.Gn('localhost:50066',
        grpc.credentials.createInsecure());
    client.sayHello({message: 'mock-client'}, function (err, response) {
        console.log('Greeting:', response.message);
    });

}

main();
