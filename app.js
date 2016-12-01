'use strict';

var Promise = require('bluebird'),
    Twit = require('twit'),
    fs = require("fs"),
    http = require('http'),
    pmongo = require('promised-mongo'),
    Schtick = require('schtick');



/* EXAMPLE CONFIGURATION

 COLLECTION:"collection-name",
 SCHTICK_SCHEDULE:'min(*%55)',  //means post will shedule to each 55 minutes
 QUERY_LIKES_COUNT: '<=900',    //should be less or equal 900 likes on post
 QUERY_ATTACHMENTS_PHOTO_EXISTS: true,  //should exist photo attachments
 QUERY_POSTED_TO_TWITTER_FIELD_EXISTS: false, // shold not be posted before
 QUERY_ATTACHMENTS_EXISTS : true, //attachments should exists
 QUERY_ATTACHMENTS_LENGTH_ABOVE : '>= 1',  //count for attachments
 QUERY_ATTACHMENTS_LENGTH_BELOW : '<= 4',
 QUERY_TEXT_LENGTH:'<= 116',  // Length for text, which can be put to twitt along with image attachments
 TWIT_CONSUMER_KEY : 'GET ON https://apps.twitter.com/',
 TWIT_CONSUMER_SECRET: 'GET ON https://apps.twitter.com/',
 TWIT_ACCESS_TOKEN: 'GET ON https://apps.twitter.com/',
 TWIT_ACCESS_SECRET: 'GET ON https://apps.twitter.com/',

 */


const DB_NAME = 'localhost/poster';

const COLLECTION = process.env.COLLECTION || 'db-collection-name';
const SCHTICK_SCHEDULE = process.env.SCHTICK_SCHEDULE || 'sec(*%30)';
const TWIT_CONSUMER_KEY = process.env.TWIT_CONSUMER_KEY || '';
const TWIT_CONSUMER_SECRET = process.env.TWIT_CONSUMER_SECRET || '';
const TWIT_ACCESS_TOKEN = process.env.TWIT_ACCESS_TOKEN || '';
const TWIT_ACCESS_SECRET = process.env.TWIT_ACCESS_SECRET || '';
const TEMP_DOWNLOAD_DIRECTORY = process.env.TEMP_DOWNLOAD_DIRECTORY || './tmp/';


const QUERY_LIKES_COUNT = process.env.QUERY_LIKES_COUNT || null;
const QUERY_ATTACHMENTS_PHOTO_EXISTS = process.env.QUERY_ATTACHMENTS_PHOTO_EXISTS || null;
const UPDATE_SET_POSTED_TO_TWITTER_FIELD = process.env.UPDATE_SET_POSTED_TO_TWITTER_FIELD || true;
const QUERY_POSTED_TO_TWITTER_FIELD_EXISTS = process.env.QUERY_POSTED_TO_TWITTER_FIELD_EXISTS || null;
const QUERY_ATTACHMENTS_EXISTS = process.env.QUERY_ATTACHMENTS_EXISTS || null;
const QUERY_ATTACHMENTS_LENGTH_ABOVE = process.env.QUERY_ATTACHMENTS_LENGTH_ABOVE || null;
const QUERY_ATTACHMENTS_LENGTH_BELOW = process.env.QUERY_ATTACHMENTS_LENGTH_BELOW || null;
const QUERY_TEXT_LENGTH = process.env.QUERY_TEXT_LENGTH || null;
const QUERY_TEXT_EXISTS = process.env.QUERY_TEXT_EXISTS || null;

var db = pmongo(DB_NAME, [COLLECTION]);
var schtick = new Schtick();

var twit = new Twit({
    consumer_key: TWIT_CONSUMER_KEY,
    consumer_secret: TWIT_CONSUMER_SECRET,
    access_token: TWIT_ACCESS_TOKEN,
    access_token_secret: TWIT_ACCESS_SECRET
})


schtick.addAsyncTask('Poster Session', SCHTICK_SCHEDULE, function (task, eventTime, done) {
    console.log(task.name + ' started ' + eventTime);
    runPoster(done);
});


var runPoster = Promise.coroutine(function* (done) {

    let item = yield getDbRecord();

    let fileNameArr = yield downloadMedia(item[0]);


    twitterPoster(item[0], fileNameArr)
        .then(function (result) {
            console.log(result);
            done();
        });


});


function twitterPoster(item, fileNameArr) {
    return new Promise(function (resolve, reject) {

        uploadMediaToTwitter(fileNameArr)
            .then(function (mediaArr) {
                return postToTwitter(item.text, mediaArr);
            })
            .then(setPostedToTwitter(item.id))
            .then(function (res) {
                resolve('Send!');

            })
            .catch(function (err) {
                console.log('Shiiit, not send:', err);
            });

    });
}


function buildDBQuery() {

    var query = {};

    if (QUERY_ATTACHMENTS_EXISTS !== null)
        query["attachments"] = {
            $exists: (QUERY_ATTACHMENTS_EXISTS == "true" ? true : false)
        };

    query["posted_to_twitter"] = {
        $exists: (QUERY_POSTED_TO_TWITTER_FIELD_EXISTS == "true" ? true : false)
    };

    if (QUERY_ATTACHMENTS_PHOTO_EXISTS !== null)
        query["attachments.photo"] = {
            $exists: (QUERY_ATTACHMENTS_PHOTO_EXISTS == "true" ? true : false)
        };

    if(QUERY_TEXT_EXISTS !== null)
        query["text"] ={
            $exists: (QUERY_TEXT_EXISTS== "true" ? true : false)
        };

    if (QUERY_TEXT_LENGTH ||
        QUERY_LIKES_COUNT ||
        QUERY_ATTACHMENTS_LENGTH_ABOVE ||
        QUERY_ATTACHMENTS_LENGTH_BELOW) {

        let andArr = [];
        if (QUERY_TEXT_LENGTH !== null)
            andArr.push({
                $where: "this.text.length " + QUERY_TEXT_LENGTH
            });

        if (QUERY_LIKES_COUNT !== null)
            andArr.push({
                $where: "this.likes.count " + QUERY_LIKES_COUNT
            });

        if (QUERY_ATTACHMENTS_LENGTH_ABOVE !== null)
            andArr.push({
                $where: "this.attachments.length " + QUERY_ATTACHMENTS_LENGTH_ABOVE
            });


        if (QUERY_ATTACHMENTS_LENGTH_BELOW !== null)
            andArr.push({
                $where: "this.attachments.length  " + QUERY_ATTACHMENTS_LENGTH_BELOW
            });

        query['$and'] = andArr;
    }

    return query;
}


function getDbRecord() {
    return db.collection(COLLECTION).find(buildDBQuery())
        .limit(1)
        .sort({date: 1}).toArray();
}


function downloadMedia(item) {
    return new Promise(function (resolve, reject) {

        if (item === undefined)
            return reject('item is undefined');

        if (item.attachments === undefined)
            return resolve([]);


        var attachments = item.attachments;


        var count = 0,
            photoArr = [];

        promiseFor(function (count) {
                return count < attachments.length;
            },
            function (count) {
                return _downloadMedia(attachments[count])
                    .then(function (res) {
                        photoArr.push(res);
                        return ++count;
                    }).catch(function (err) {
                        console.log(err);
                    });
            },
            0)
            .then(resolve.bind(resolve, photoArr))
            .catch(function (err) {
                console.log('Download Media Error', err);
                reject(err);
            });
    });
}


function uploadMediaToTwitter(filenameArr) {
    return new Promise(function (resolve, reject) {

        if (filenameArr.length === 0)
            return resolve([]);

        var count = 0;
        var mediaIdArr = [];

        promiseFor(function (count) {
                return count < filenameArr.length;
            }, function (count) {
                return _uploadToTwitter(filenameArr[count])
                    .then(function (res) {
                        mediaIdArr.push(res);
                        return ++count;
                    }).catch(function (err) {
                        console.log('twi upload failed', err);
                    })
            },
            0)
            .then(resolve.bind(resolve, mediaIdArr));

    });

}

function postToTwitter(status, mediaIdArr) {
    return new Promise(function (resolve, reject) {

        console.log(status);
        console.log(mediaIdArr);

        let postObject = {
            status: status,
            media_ids: mediaIdArr
        };

        if (status === undefined)
            return reject('status is undefined');

        if (mediaIdArr.length === 0)
            delete postObject.media_ids;

        twit.post('statuses/update',
            postObject,
            function (err, data, response) {
                if (err) {
                    console.log(err);
                    reject(err);
                }
                resolve(data.text);
            })

    });
}

function setPostedToTwitter(itemId) {
    return new Promise(function (resolve, reject) {

        if (UPDATE_SET_POSTED_TO_TWITTER_FIELD !== true)
            return resolve('set to not update posted_to field');

        db.collection(COLLECTION).update({
            id: itemId
        }, {
            $set: {
                posted_to_twitter: new Date()
            }

        }).then(function (res) {
            console.log("Item " + itemId + " updated");
            resolve(res);
        }).catch(function (err) {
            console.log('Cannot update item: ' + itemId);
            reject(err);
        });

    });
}

var _getBiggestSizePhotoUrl = function (attachmentPhotoObject) {

    function strpos(haystack, needle, offset) {
        var i = (haystack + '').indexOf(needle, (offset || 0));
        return i === -1 ? false : i;
    }

    var photosizes = [];
    var biggestSizePhoto;

    for (var k in attachmentPhotoObject) {
        if (strpos(k, "photo_") === 0) {
            //to get SIZE, URL ARRAY [ 807, 'http://cs317718.vk.me/v317718170/23bb/-WJTxwOIA6o.jpg' ]
            photosizes.push([parseInt(k.replace(/[^\d.]/g, '')), attachmentPhotoObject[k]]);
        }
    }

    //get maximum size url
    biggestSizePhoto = photosizes.reduce(function (p, v) {
        return (p[0] > v[0] ? p : v);
    });

    //we don't need width so just return URL
    return biggestSizePhoto[1];

};


var promiseFor = Promise.method(function (condition, action, value) {
    if (!condition(value)) return value;
    return action(value).then(promiseFor.bind(null, condition, action));
});

function _downloadMedia(attachment) {
    return new Promise(function (resolve, reject) {

        if (attachment.type !== 'photo')
            return reject('not a photo');


        var fileUrl = _getBiggestSizePhotoUrl(attachment.photo);
        var fileName = fileUrl.split('/').pop();

        try {
            var file = fs.createWriteStream(TEMP_DOWNLOAD_DIRECTORY + fileName);

            http.get(fileUrl, function (response) {
                response.pipe(file);

                file.on('finish', function () {
                    file.close(function (err) {
                        if (err) {
                            reject(err);
                        }
                        resolve(fileName);
                    });

                });

            }).on('error', function (err) {
                console.log('File write error:', err);
                fs.unlink(TEMP_DOWNLOAD_DIRECTORY + fileName, function (err) {
                    if (err) {
                        console.log('File delete error', err);
                        reject(err);
                    }
                });
            });


        } catch (err) {
            console.log(err);
            reject(err);
        }

    });
}


function _uploadToTwitter(filename) {
    return new Promise(function (resolve, reject) {

        var b64content = fs.readFileSync(TEMP_DOWNLOAD_DIRECTORY + filename, {
            encoding: 'base64'
        });
        twit.post('media/upload', {
            media_data: b64content
        }, function (err, data, response) {

            if (err) {
                console.log('Upload to Twitter error:', err);
                reject(err);
            }

            fs.unlink(TEMP_DOWNLOAD_DIRECTORY + filename, function (err) {
                if (err) {
                    console.log('File delete error', err);
                    reject(err);
                }
            });

            resolve(data.media_id_string);
        });
    });
}


