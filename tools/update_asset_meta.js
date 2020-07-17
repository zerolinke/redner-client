const fs = require('fs');
const md5File = require('md5-file');
const axios = require('axios');
const path = require('path');
const util = require('util');
const moment = require('moment');
const uuid = require('uuid');
const ffprobe = require('ffprobe');
const ffprobeStatic = require('ffprobe-static');
const ftp = require("basic-ftp");
const gifyParse = require('gify-parse');


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

function deleteFile(pathStr) {
    if (fs.existsSync(pathStr)) {
        fs.unlinkSync(pathStr);
    }
}

async function updateAssetMetaByClient(labelUID, assetUID, assetDurationStr, assetDimensionStr) {
    try {
        const response = await axios.post(ASSETHUB_SERVER_API_BASE_URL + 'asset/meta/update/client',
            {
                change_label_uid: labelUID,
                asset_uid: assetUID,
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

async function __downloadFromFTPServer(currentTaskID, currentTaskItemID, localPath, fromPath) {
    const verbose = false;
    const client = new ftp.Client();
    client.ftp.verbose = false;
    client.trackProgress(info => {
        verbose && console.log('track_progress: ', JSON.stringify(info));
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

async function retrieveAssetFileAndUpdateMeta(taskUID, assetData) {
    const rootPath = path.dirname(__dirname);
    const renderTaskPath = path.join(rootPath, 'updatemeta');
    const taskRenderTaskPath = path.join(renderTaskPath, taskUID);
    const taskRenderTaskAssethubPath = path.join(taskRenderTaskPath, 'assethub')
    console.log(timestamp(), '[redner-client][tools][update-asset-meta] TaskUID:', taskUID, "Update Meta Task Path:", taskRenderTaskPath);

    if (fs.existsSync(taskRenderTaskPath)) {
        // TODO: remove dir
        deleteFolderRecursive(taskRenderTaskPath);
    }

    fs.mkdirSync(taskRenderTaskPath, {recursive: true});
    fs.mkdirSync(taskRenderTaskAssethubPath, {recursive: true});

    console.log(timestamp(), '[redner-client][tools][update-asset-meta] Asset Meta Data Length: ', assetData.length);


    for (let i = 0; i < assetData.length; i++) {
        try {
            let assetName = assetData[i].asset_name;
            let labelUID = assetData[i].label_uid;
            let assetUID = assetData[i].label_asset_ref;

            console.log(timestamp(), '[redner-client][tools][update-asset-meta] Downloading ', i, ' - ', assetName);
            const pending_media_path = path.join(taskRenderTaskAssethubPath, assetName)
            const downloadResult = await downloadFromNas(taskUID, downloadIndex, taskRenderTaskAssethubPath, assetName)
            if (downloadResult) {
                console.log(timestamp(), '[redner-client][tools][update-asset-meta] Download successed.');
            } else {
                console.log(timestamp(), '[redner-client][tools][update-asset-meta] Download failed.');
            }
            // Pending: get meta info and update meta
            console.log(timestamp(), '[redner-client][tools][update-asset-meta] Get File Meta');
            const fileMetaData = await getFileMeta(pending_media_path);
            console.log(timestamp(), '[redner-client][tools][update-asset-meta] Update Asset Meta');
            const updateResult = await updateAssetMetaByClient(labelUID, assetUID, fileMetaData.durationStr, fileMetaData.dimensionsStr)
            if (updateResult.result_code === 200) {
                console.log(timestamp(), '[redner-client][tools][update-asset-meta] Update Successed.');
            } else {
                console.log(timestamp(), '[redner-client][tools][update-asset-meta] Update Result Error: ', updateResult);
            }
            deleteFile(pending_media_path);
        } catch (err) {
            console.log(timestamp(), err)
        }
    }

    return taskRenderTaskPath;

}

// Pending: get asset meta list from Assethub

async function retrieveAssetMetaAll() {
    try {
        const response = await axios.get(ASSETHUB_SERVER_API_BASE_URL + 'asset/meta/list');
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

async function run() {
    console.log(timestamp(), '[redner-client][tools][update-asset-meta] Start');
    const startTime = moment(Date.now());
    const assetMetaListSourceData = await retrieveAssetMetaAll();
    const assetMetaList = assetMetaListSourceData.result.data.asset_meta;
    const taskUID = uuid.v4()
    await retrieveAssetFileAndUpdateMeta(taskUID, assetMetaList);
    const endTime = moment(Date.now());
    const minutesDiff = endTime.diff(startTime, 'minutes')
    console.log(timestamp(), '[redner-client][tools][update-asset-meta] End With Spend Time: ' + minutesDiff + 'm');
}

run();
