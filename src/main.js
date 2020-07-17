const fs = require('fs');
const md5File = require('md5-file');
const axios = require('axios');
const path = require('path');
const util = require('util');
const moment = require('moment');
const uuid = require('uuid');
const gifyParse = require('gify-parse');
const ffprobe = require('ffprobe');
const ffprobeStatic = require('ffprobe-static');
const ftp = require("basic-ftp");
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

// TODO: Configuration
const GRPC_SERVER_PORT = 50066
const TEMP_ASSET_ROOT_PATH = ''
const jsonConfig = require('../config/config.json')
const NAS_HOST = jsonConfig.nas.host;
const NAS_HOST_USER = jsonConfig.nas.user;
const NAS_HOST_PASSWORD = jsonConfig.nas.password;
const ASSETHUB_SERVER_IP = jsonConfig.assethub_server.ip;
const ASSETHUB_SERVER_PORT = jsonConfig.assethub_server.port;

const ASSETHUB_SERVER_API_BASE_URL = 'http://' + ASSETHUB_SERVER_IP + ':' + ASSETHUB_SERVER_PORT + '/api/v2/';
const TARGET_DATA_PATH = 'C:\\Users\\zerol\\WebstormProjects\\redner-client\\data';
// TODO: Configuration end

function timestamp() {
    return moment(Date.now())
        .format('YYYY-MM-DDTHH:mm:ss');
}

function deleteFolderRecursive(pathStr) {
    if (fs.existsSync(pathStr)) {
        fs.readdirSync(pathStr).forEach((file, index) => {
            const curPath = path.join(pathStr, file);
            if (fs.lstatSync(curPath).isDirectory()) { // recurse
                deleteFolderRecursive(curPath);
            } else { // delete file
                fs.unlinkSync(curPath);
            }
        });
        fs.rmdirSync(pathStr);
    }
}

async function __downloadFromFTPServer(currentTaskID, currentTaskItemID, localPath, fromPath) {
    const client = new ftp.Client();
    client.ftp.verbose = false;
    client.trackProgress(info => {
        console.log('track_progress: ', JSON.stringify(info));
    });

    // TODO: 此处可以用更详细的返回码处理错误类型
    //  ok === 0;
    //  error === 1;
    const DOWNLOAD_OK = 0
    const DOWNLOAD_ERROR = 1;
    let downloadResult = DOWNLOAD_OK;

    try {
        await client.access({
            host: NAS_HOST,
            user: NAS_HOST_USER,
            password: NAS_HOST_PASSWORD,
            secure: false
        });

        // TODO: need ? await client.ensureDir("/assethub/");
        // FIXME: check download path and download file path
        // await client.downloadTo(pending_media_path, downloadFromPath + pending_media_name);
        await client.downloadTo(localPath, fromPath);
    } catch (err) {
        downloadResult = DOWNLOAD_ERROR;
        console.log(err);
    } finally {
        client.trackProgress();
        client.close();
    }
    return downloadResult;
}

/**
 * Download From Nas
 * @param currentTaskID
 * @param currentTaskItemID
 * @param downloadPath
 * @param pending_media_name
 * @returns {Promise<boolean>}
 */
async function downloadFromNas(currentTaskID, currentTaskItemID, downloadPath, pending_media_name) {
    const downloadFromNasPath = '\/assethub\/';
    const pending_media_path = path.join(downloadPath, pending_media_name)
    const downloadResult = await __downloadFromFTPServer(currentTaskID, currentTaskItemID, pending_media_path, downloadFromNasPath + pending_media_name)
    return downloadResult === 0;
}


async function retrieveAssetFile(taskUID, rednerData) {
    const rootPath = path.dirname(__dirname);
    const renderTaskPath = path.join(rootPath, 'rendertask');
    const taskRenderTaskPath = path.join(renderTaskPath, taskUID);
    const taskRenderTaskAssethubPath = path.join(taskRenderTaskPath, 'assethub')
    console.log('TaskUID:', taskUID, "Render Task Path:", taskRenderTaskPath);

    if (fs.existsSync(taskRenderTaskPath)) {
        // TODO: remove dir
        deleteFolderRecursive(taskRenderTaskPath);
    }

    fs.mkdirSync(taskRenderTaskPath, {recursive: true});
    fs.mkdirSync(taskRenderTaskAssethubPath, {recursive: true});

    let assetList = rednerData.assets;
    let length = assetList.length;
    console.log('assetList.length: ', length);
    let tempSetForDownload = new Set();
    for (let i = 0; i < length; i++) {
        let url = assetList[i].down_info.params.url;
        var fileName = url.replace(/^.*[\\\/]/, '')
        console.log(i, ' ', url, ' ', fileName);

        fileName = '56b1383baea10c2c2f107e49275d7e93.mp4';
        tempSetForDownload.add(fileName)

    }

    console.log('Waiting for download: ', tempSetForDownload.size, ' item:');
    let downloadIndex = 0;
    for (var item of tempSetForDownload) {
        console.log('Downloading ', downloadIndex, ' - ', item, 'to', taskRenderTaskAssethubPath);
        const downloadResult = await downloadFromNas(taskUID, downloadIndex, taskRenderTaskAssethubPath, item)
        if (downloadResult) {
            console.log('Download successed.');
        } else {
            console.log('Download failed.');
        }
        downloadIndex += 1;
    }

    return taskRenderTaskPath;

}

async function sayHello(call, callback) {
    console.log(timestamp(), '[redner-client][SayHello] Receive Request: {id}');
    callback(null, {message: 'Hello ' + call.request.message + ' This is redner-client.'});
    console.log(timestamp(), '[redner-client][SayHello] Response With {id}');
}

async function __uploadToFTPServer(currentTaskID, currentTaskItemID, path, newName) {
    // Pending: 此处加入一个逻辑步骤用来缓解上传的不确定性
    //  1. 上传到临时位置
    //  2. 上传完成后移动到assethub中
    const thisUid = uuid.v4();

    // TODO: 确保临时目录存在
    const ftpAssethubPath = "\/assethub\/";
    const ftpAssethubTempPath = ftpAssethubPath + "temp\/";
    const ftpAssethubTempUploadPath = ftpAssethubTempPath + thisUid + "\/";

    const client = new ftp.Client();
    client.ftp.verbose = false;
    client.trackProgress(info => {
        console.log('[Upload] track_progress: ', JSON.stringify(info));
    });

    // TODO: 此处可以用更详细的返回码处理错误类型
    //  ok === 0;
    //  error === 1;
    const UPLOAD_OK = 0
    const UPLOAD_ERROR = 1;
    let uploadResult = UPLOAD_OK;

    try {
        await client.access({
            host: NAS_HOST,
            user: NAS_HOST_USER,
            password: NAS_HOST_PASSWORD,
            secure: false
        });

        // console.log(await client.list());
        // // TODO: ensure dir exist
        // await client.ensureDir("\/assethub\/");


        await client.ensureDir(ftpAssethubTempPath);
        await client.ensureDir(ftpAssethubTempUploadPath);

        const uploadFTPServerFileName = ftpAssethubTempUploadPath + newName;
        // TODO: list
        // const result = await client.list("assethub\/1-1Z123014121.png");

        // FIXME: pending to resolve
        // try {
        //     // TODO: 文件已存在表示
        //     const result = await client.size(uploadFTPServerFileName);
        //     console.log("list result", result);
        // } catch (e) {
        //     // TODO: 可以在此处通知服务器 通过return一个int
        //     console.log('error:', e);
        //     client.close();
        //     return false;
        //
        // }

        // TODO: 上传到临时地址
        await client.uploadFrom(path, uploadFTPServerFileName);
        // TODO: 从临时地址移动到assethub中
        await client.rename(uploadFTPServerFileName, ftpAssethubPath + newName)
        // TODO: 移除临时目录
        await client.removeDir(ftpAssethubTempUploadPath)

        // // TODO: ensure dir exist
        // await client.ensureDir("/assethub/");
        // // await client.uploadFrom("README.md", "README_FTP.md");
        // // TODO: 此处的路径测试结果
        // //  1. uploadFrom toRemotePath 无法使用 \\ 可以使用 / 和 // 和 \/
        // //  2. downloadTo fromRemotePath 无法使用 \\ 可以使用 / 和 // 和 \/
        // await client.uploadFrom("C:\\Users\\zerol\\WebstormProjects\\eboda-pr-autoflow\\client\\sample\\TEST.md", "\/assethub\/TEST_FTP6.md");
        // await client.downloadTo("C:\\Users\\zerol\\WebstormProjects\\eboda-pr-autoflow\\client\\sample\\TEST_FTP3_COPY.md", "\/assethub\/TEST_FTP6.md");
    } catch (err) {
        // Pending: 客户端显示错误信息
        uploadResult = UPLOAD_ERROR;
        console.log(err);
    } finally {
        client.trackProgress();
        client.close();
    }
    return uploadResult;

}

async function checkAssetExist(assetDigest) {
    try {
        const response = await axios.get(ASSETHUB_SERVER_API_BASE_URL + 'asset/exist/' + assetDigest);
        return await response.data
    } catch (error) {
        console.log(error);
        return {
            result: {
                code: 400,
            }
        }
    }
}

/**
 * Update Project Item Render Ref
 * @param taskUID
 * @param asset_uid
 * @returns {Promise<number|*>}
 */
async function updateProjectItemPrprojOrRender(taskUID, asset_uid) {
    try {
        const response = await axios.post(ASSETHUB_SERVER_API_BASE_URL + 'prgn/project/item/render/update',
            {
                project_item_uid: taskUID,
                render_ref: asset_uid,
            });

        console.log("updateProjectItemPrprojOrRender ", response.data.result.code)

        var data = await response.data;
        return data.result.code;
    } catch (error) {
        console.log(error);
        return 400;
    }
}

/**
 * Create Temporary File
 * @param tagList
 * @param assetDigest
 * @param assetName
 * @param assetDurationStr
 * @param assetDimensionStr
 * @returns {Promise<{result_code: number}|{result_code: *, asset_uid}>}
 */
async function createTemporaryAssetClient(tagList, assetDigest, assetName, assetDurationStr, assetDimensionStr) {
    try {
        // types: [[], [], [], []],
        // tags: ['西部世界', '李尸王朝'],
        // asset_digest: 'abc123',
        // asset_name: 'abc123.mp3'
        const response = await axios.post(ASSETHUB_SERVER_API_BASE_URL + 'asset/create/temporary/client',
            {
                types: [[], [], [], []],
                tags: tagList,
                asset_digest: assetDigest,
                asset_name: assetName,
                asset_duration: assetDurationStr,
                asset_dimensions: assetDimensionStr,
            });

        var data = await response.data;

        return {result_code: data.result.code, asset_uid: data.result.data.asset_uid};
    } catch (error) {
        console.log(error);
        return {result_code: 400};

    }
}

function convertFrameToHMSF(frame, fps) {
    const f = frame % fps;
    const second = (frame - f) / fps;
    let fStr = '';
    // pad zero
    if (f < 10) {
        fStr = '0' + f;
    } else {
        fStr = f + '';
    }
    return new Date(second * 1000).toISOString()
        .substr(11, 8) + ':' + fStr;
}

async function getFileMeta(pathStr) {
    const verbose = false;

    let durationStr = '00:00:00:00'
    let dimensionsStr = '0*0'
    try {
        const audioExtname = ['.mp3']
        const videoExtname = ['.webm', '.mov', '.wmv', '.mpg', '.mpeg', '.mp4', '.flv']
        const imageExtname = ['.jpg', '.png']
        const animatedExtname = ['.gif']

        let fileExtname = path.extname(pathStr).toLowerCase();
        const fileMetaData = await ffprobe(pathStr, {path: ffprobeStatic.path})
        verbose && console.log('fileMetaData: ', fileMetaData);
        const fileMetaDataStreams = fileMetaData.streams;
        if (audioExtname.includes(fileExtname)) {
            // audio
            if (fileMetaDataStreams[0].codec_type === 'audio') {
                const duration_second_source = fileMetaDataStreams[0].duration;
                const duration_second_x_2 = (duration_second_source / 1) * 25;
                const duration_second_x_2_trunc_frame = Math.trunc(duration_second_x_2);
                const duration_second_x_2_HMSF = await convertFrameToHMSF(duration_second_x_2_trunc_frame, 25);
                verbose && console.log(duration_second_source, duration_second_x_2, duration_second_x_2_trunc_frame, duration_second_x_2_HMSF);
                durationStr = duration_second_x_2_HMSF;
            }
        } else if (videoExtname.includes(fileExtname)) {
            // video
            for (let i = 0; i < fileMetaDataStreams.length; i++) {
                if (fileMetaDataStreams[i].codec_type === 'video') {
                    const duration_second_source = fileMetaDataStreams[i].duration;
                    // TODO: change Math.floor to Math.tranc
                    const duration_second_x_2 = (duration_second_source / 1) * 25;
                    const duration_second_x_2_trunc_frame = Math.trunc(duration_second_x_2);
                    const duration_second_x_2_HMSF = await convertFrameToHMSF(duration_second_x_2_trunc_frame, 25);
                    verbose && console.log('duration_second_x_2: ', duration_second_x_2, ' duration_second_x_2_trunc_frame:', duration_second_x_2_trunc_frame, 'duration_second_x_2_HMSF:', duration_second_x_2_HMSF);

                    durationStr = duration_second_x_2_HMSF;
                    dimensionsStr = fileMetaDataStreams[i].width + '*' + fileMetaDataStreams[i].height;
                    verbose && console.log('video3')
                }
            }

        } else if (imageExtname.includes(fileExtname)) {
            // image
            if (fileMetaDataStreams[0].codec_type === 'video') {
                dimensionsStr = fileMetaDataStreams[0].width + '*' + fileMetaDataStreams[0].height;
            }

        } else if (animatedExtname.includes(fileExtname)) {
            // animate
            var buffer = fs.readFileSync(pathStr);
            var gifInfo = gifyParse.getInfo(buffer);
            verbose && console.log(gifInfo.duration)
            const duration_second_source = gifInfo.duration / 1000;

            const duration_second_x_2 = (duration_second_source / 1) * 25;
            const duration_second_x_2_trunc_frame = Math.trunc(duration_second_x_2)
            const duration_second_x_2_HMSF = await convertFrameToHMSF(duration_second_x_2_trunc_frame, 25)
            verbose && console.log('duration_second_x_2: ', duration_second_x_2, ' duration_second_x_2_trunc_frame:', duration_second_x_2_trunc_frame, 'duration_second_x_2_HMSF:', duration_second_x_2_HMSF);
            durationStr = duration_second_x_2_HMSF
            if (fileMetaDataStreams[0].codec_type === 'video') {
                dimensionsStr = fileMetaDataStreams[0].width + '*' + fileMetaDataStreams[0].height;
            }

        } else {
        }
        return {dimensionsStr, durationStr}
    } catch (e) {
        verbose && console.log(e)
        return {dimensionsStr, durationStr}
    }

}

async function __uploadToNas(taskUID, pendingUploadFilePath) {
    let item = {};
    item['media_path'] = pendingUploadFilePath;

    console.log('MAIN.FLOW.UPLOAD.STAGE.S1_DIGEST.START')
    // Pending: digest file
    if (fs.existsSync(pendingUploadFilePath)) {

        const hash = await md5File(pendingUploadFilePath);
        // Pending: 通知md5计算完成
        item['digest'] = hash;
        item['is_exist_digest'] = true;

        console.log('MAIN.FLOW.UPLOAD.STAGE.S1_DIGEST.START')

    } else {
        // Pending: 通知md5计算失败
        item['is_exist_digest'] = false;
        console.log('MAIN.FLOW.UPLOAD.STAGE.S1_DIGEST.ERROR')
    }

    console.log('MAIN.FLOW.UPLOAD.STAGE.S2_SEARCH.START')

    // Pending: Asset Server Exist Check
    if (item['is_exist_digest']) {
        let pending_digest = item['digest'];
        let checkResultData = await checkAssetExist(pending_digest);

        if (checkResultData.result.code === 200) {
            // Pending: 请求正常返回
            if (checkResultData.result.data.is_exist) {
                // Pending: 素材存在
                // TODO: asset digest is exist
                item['asset_is_exist'] = true;
                item['asset_uid'] = checkResultData.result.data.asset_uid;

                console.log('MAIN.FLOW.UPLOAD.STAGE.S2_SEARCH.OK_EXIST')

            } else {
                // Pending: 素材不存在
                // TODO: asset digest is not exist
                item['asset_is_exist'] = false;
                console.log('MAIN.FLOW.UPLOAD.STAGE.S2_SEARCH.OK_NON_EXIST');
            }
        } else {
            // Pending: 请求未正常返回
            item['asset_is_exist'] = true; // FIXME: 保护性设置防止上传

            console.log('MAIN.FLOW.UPLOAD.STAGE.S2_SEARCH.ERROR');
        }
    }

    if (item['is_exist_digest'] && !item['asset_is_exist']) {
        // Pending: 开始上传素材
        // TODO
        let pending_digest = item['digest'];
        // TODO: name use hash join suffix   xxxx.mp4
        let pathSourceName = pendingUploadFilePath.split('.');
        const postfix = pathSourceName[pathSourceName.length - 1];
        var newName = pending_digest + "." + postfix;

        const fileMetaData = await getFileMeta(pendingUploadFilePath);

        const uploadResult = await __uploadToFTPServer(taskUID, taskUID, pendingUploadFilePath, newName)
        if (uploadResult === 0) {
            // TODO: 上传成功
            const createResult = await createTemporaryAssetClient([], pending_digest, newName, fileMetaData.durationStr, fileMetaData.dimensionsStr);

            if (createResult.result_code === 200) {

                const updateResult = await updateProjectItemPrprojOrRender(taskUID, createResult.asset_uid);
                if (updateResult === 200) {
                    item['uploaded'] = true;

                    // Pending: 上传成功

                    // TODO: 同步日志
                    let timestamp = moment(Date.now())
                        .format('YYYY-MM-DD HH:mm:ss ');
                    console.log('MAIN.SYNC_EVENT_LOG');
                }
            } else {
                // Pending: 上传失败 - 服务器注册时失败
            }

        } else {
            // Pending: 上传失败 - 传输错误
            // TODO: 上传错误
        }
    } else if (item['is_exist_digest'] && item['asset_is_exist']) {
        // TODO: 素材存在则直接更新到project_item
        if (item['asset_uid']) {
            await updateProjectItemPrprojOrRender(taskUID, item['asset_uid']);
        }
    }
}

async function uploadRenderResult(taskUID, pendingUploadPath) {
    await __uploadToNas(taskUID, pendingUploadPath)
}

async function watchRenderResult(watchPath) {
    let sleep = util.promisify(setTimeout);
    let watch = true
    while (watch) {
        await sleep(1000);
        if (fs.existsSync(watchPath)) {
            console.log('watch exist');
            watch = false;
        } else {
            console.log('watch...');
        }

    }
    await sleep(1000);
    console.log('watch done');
}

async function removeTaskRenderTaskPath(taskRenderTaskPath) {
    try {
        deleteFolderRecursive(taskRenderTaskPath);
    } catch (err) {
        throw err;
    }
}

async function callRednerService(rednerData) {
    const response = await axios.post('http://0.0.0.0:80/201903v1/internal/merge_request', rednerData);
    const respData = await response.data;
    console.log(timestamp(), '[redner-client][SayHello] Call Redner Service And Resp Date: ', respData);
}

async function generate(call, callback) {
    const taskUID = call.request.project_item_uid;
    console.log(timestamp(), '[redner-client][Generate] Receive Request: ' + taskUID);
    // Pending: receive request

    const rednerDataJSONStr = call.request.data;
    const rednerData = JSON.parse(rednerDataJSONStr);
    const rednerDataTaskID = rednerData.task_id;
    const rednerDataTargetInfoFileName = rednerData.target_info.file_name;
    const rednerDataTargetInfoFormat = rednerData.target_info.format;
    const rednerDataTargetFileName = rednerDataTargetInfoFileName + '.' + rednerDataTargetInfoFormat;
    console.log('taskUID: ', taskUID, 'rednerDataJSONStr: ', rednerDataJSONStr);
    // Pending: Prepare - retrieve asset file from Nas
    const taskRenderTaskPath = await retrieveAssetFile(taskUID, rednerData);
    // Pending: Call - render request
    await callRednerService(rednerData);
    // Pending: monitor path of render result
    const promiseRenderResultFolderPath = path.join(TARGET_DATA_PATH, rednerDataTaskID);
    const promiseRenderResultPath = path.join(promiseRenderResultFolderPath, rednerDataTargetFileName);
    await watchRenderResult(promiseRenderResultPath);
    // Pending: Upload render result
    await uploadRenderResult(taskUID, promiseRenderResultPath);
    // Pending: Remove Temp Asset File
    await removeTaskRenderTaskPath(taskRenderTaskPath);
    // Pending: response
    callback(null, {message: 'Hello ' + call.request.message + ' This is redner-client.'});
    console.log(timestamp(), '[redner-client][Generate] Response With ' + taskUID);
}


/**
 * Starts an RPC server that receives requests for the Greeter service at the
 * sample server port
 */
const server = new grpc.Server();
server.addService(pr_proto.RednerGn.service, {sayHello: sayHello, generate: generate});
server.bind('0.0.0.0:' + GRPC_SERVER_PORT, grpc.ServerCredentials.createInsecure());
server.start();
console.log(timestamp(), '[redner-client][server] Redner-Client gRPC Server listening on port: ', GRPC_SERVER_PORT)
