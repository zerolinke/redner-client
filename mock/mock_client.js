const moment = require('moment')
const uuid = require('uuid')
const PROTO_PATH = __dirname + '\\..\\protos\\pr_gn.proto';
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
    var client = new pr_proto.RednerGn('localhost:50066',
        grpc.credentials.createInsecure());
    // client.sayHello({message: 'mock-client'}, function (err, response) {
    //     console.log('Greeting:', response.message);
    // });
    const mockProjectItemUID = uuid.v4()
    const mockdata = require('./mock_data.json');
    const mockdataJSONStr = JSON.stringify(mockdata);
    client.generate({project_item_uid: mockProjectItemUID, data: mockdataJSONStr}, function (err, response) {
        console.log('generate response: ', response.message);
    });


}

main();
