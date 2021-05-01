import { credentials } from "./credentials.js";
import { CustomLocalStorage } from "../../spotify-util/js/customLocalStorage.js";

const CURRENT_VERSION = "0.1.0",
    REFRESH_RATE = { //used to control API rate limiting
        getUserPlaylists: 1,
        getPlaylistTracks: 250,
        addTracksToPlaylist: 150
    },
    USER_OPTIONS = {
        allow_explicits:true,
        allow_duplicates:false,
        include_private:false,
        include_collaborative:false,
        include_followed:false,
        include_christmas:false,
        setOption: function (option_name, option_value) {
            //if(!option_name || !option_value) return false;
            if (this[option_name] !== undefined) return this[option_name] = option_value;
        },
        resetOptions: function () {
            this.allow_explicits = true;
            this.allow_duplicates = false;
            this.include_private = false;
            this.include_collaborative = false;
            this.include_followed = false;
            this.include_christmas = false;
        }
    };

//some global variables
var customLocalStorage = new CustomLocalStorage('recentsongcollector');
var spotify_credentials = null;
var CURRENTLY_RUNNING = false;
var playlist_title = "Recently Discovered Songs";
var playlist_objects = [];
var database;
var total_track_number = 0;
var global_playlist_tracks = [];


function callSpotify(url, data) {
    if(!spotify_credentials) return new Promise((resolve, reject) => reject("no spotify_credentials"));
    return $.ajax(url, {
        dataType: 'json',
        data: data,
        headers: {
            'Authorization': 'Bearer ' + spotify_credentials.token
        }
    });
}

function postSpotify(url, json, callback) {
    $.ajax(url, {
        type: "POST",
        data: JSON.stringify(json),
        dataType: 'json',
        headers: {
            'Authorization': 'Bearer ' + spotify_credentials.token,
            'Content-Type': 'application/json'
        },
        success: function (r) {
            callback(true, r);
        },
        error: function (r) {
            // 2XX status codes are good, but some have no
            // response data which triggers the error handler
            // convert it to goodness.
            if (r.status >= 200 && r.status < 300) {
                callback(true, r);
            } else {
                callback(false, r);
            }
        }
    });
}

function deleteSpotify(url, callback) {
    $.ajax(url, {
        type: "DELETE",
        //data: JSON.stringify(json),
        dataType: 'json',
        headers: {
            'Authorization': 'Bearer ' + spotify_credentials.token,
            'Content-Type': 'application/json'
        },
        success: function (r) {
            callback(true, r);
        },
        error: function (r) {
            // 2XX status codes are good, but some have no
            // response data which triggers the error handler
            // convert it to goodness.
            if (r.status >= 200 && r.status < 300) {
                callback(true, r);
            } else {
                callback(false, r);
            }
        }
    });
}

/**
 * Shuffles an array and does not modify the original.
 * 
 * @param {array} array - An array to shuffle.
 * @return {array} A shuffled array.
 */
function shuffleArray(array) {
    //modified from https://javascript.info/task/shuffle

    let tmpArray = [...array];

    for (let i = tmpArray.length - 1; i > 0; i--) {
        let j = Math.floor(Math.random() * (i + 1)); // random RESPONSE_INDEX from 0 to i

        // swap elements tmpArray[i] and tmpArray[j]
        // we use "destructuring assignment" syntax to achieve that
        // you'll find more details about that syntax in later chapters
        // same can be written as:
        // let t = tmpArray[i]; tmpArray[i] = tmpArray[j]; tmpArray[j] = t
        [tmpArray[i], tmpArray[j]] = [tmpArray[j], tmpArray[i]];
    }
    return tmpArray;
}

function okToRecursivelyFix(error_obj) {
    //determine if an error object is an api rate issue that can be fixed by calling it again,
    //or an error on our end (such as syntax) that can't be fixed by recalling the api
    console.log("checking if err is ok to recursively fix", error_obj);
    if (error_obj.status >= 429) return true;
    else {
        console.log("err NOT ok to recursively fix", error_obj);
        return false
    };
}

function loginWithSpotify() {
    if (document.location.hostname == 'localhost') {
        credentials.spotify.redirect_uri = 'http://localhost:8888/index.html';
    }

    let url = 'https://accounts.spotify.com/authorize?client_id=' + credentials.spotify.client_id +
        '&response_type=token' +
        '&scope=' + encodeURIComponent(credentials.spotify.scopes) +
        '&redirect_uri=' + encodeURIComponent(credentials.spotify.redirect_uri);

    //redirect the page to spotify's login page. after login user comes back to our page with a token in
    //page hash, or, if they're already logged in, a token in customLocalStorage's spotify_credentials
    document.location = url;
}

function getTime() {
    return Math.round(new Date().getTime() / 1000);
}

function estimateTimeTotal(track_count) {
    //estimates the amount of time it will take to generate a random playlist with the given amount of songs
    //returns the estimated time in milliseconds
    if (isNaN(track_count) || track_count == 0) return 0;
    let total = 1000; //1sec cushion
    total += track_count * REFRESH_RATE.populateAlbumArray;
    total += Math.ceil(track_count / 20) * REFRESH_RATE.populateSongArray;
    total += Math.ceil(track_count / 100) * REFRESH_RATE.addTracksToPlaylist;
    return total;
}

function estimateTimeRemaining({remaining_tracks, total_tracks = global_track_count} = {}) {
    //estimates the amount of time left until the remaining number of tracks have been added
    //returns the estimated time in milliseconds
    if(isNaN(remaining_tracks) || isNaN(total_tracks)) return 0;
    if (remaining_tracks < 0) remaining_tracks = 0;
    let total = 0;
    total += remaining_tracks * REFRESH_RATE.populateAlbumArray;
    total += Math.ceil(remaining_tracks / 20) * REFRESH_RATE.populateSongArray;
    total += Math.ceil(total_tracks / 100) * REFRESH_RATE.addTracksToPlaylist;
    return total;
}

function readableMs(ms) {
    //returns a readable, english version of a time given in ms
    let str = "",
        [hours, mins, secs] = [0, 0, 0];
    hours = Math.floor(ms / 1000 / 60 / 60);
    ms -= (hours * 1000 * 60 * 60);
    mins = Math.floor(ms / 1000 / 60);
    ms -= (mins * 1000 * 60);
    secs = Math.floor(ms / 1000); //floor instead of round to prevent displaying 60sec
    str = `${hours > 0 ? `${hours}${hours==1 ? "hr":"hrs"} `:""}${mins > 0 ? `${mins}${mins==1 ? "min":"mins"} `:""}${secs}${secs==1 ? "sec":"secs"}`;
    return str;
}

const ERROR_OBJ = {
    //100: invalid input
    
}

function displayError(code) {
    console.log(`Displaying error ${code}`);
}

const progress_bar = new ProgressBar.Line('#progress-bar', {
    color: '#1DB954',
    duration: 300,
    easing: 'easeOut',
    strokeWidth: 2
});

function scaleNumber(n, given_min, given_max, target_min, target_max) {
    let given_range = given_max - given_min,
    target_range = target_max - target_min;
    return ((n - given_min) * target_range / given_range) + target_min;
}

function progressBarHandler({current_operation, total_operations, stage = 1, ...junk} = {}) {
    //the idea is that each api call we make results in the progress bar updating
    //we need to get the total number of calls that will be made
    //let total_operations = total_tracks + Math.ceil(total_tracks / 20) + Math.ceil(total_tracks / 100);
                            //+ recursive_operations.missing_tracks + recursive_operations.get_album_calls;
    //^ see the algorithm used in estimateTimeTotal
    if(stage == "done") {
        progress_bar.animate(1);
        $("#estimated-time-remaining p").text("Done!");
        return;
    }

    let animate_value = 0,
    estTimeText = "Unknown";

    let stage_text = {
        1:() => "Getting your playlists...",
        2:() => {
            if(!junk.playlist_name) return `Retrieving playlist songs...`;
            else return `Retrieving songs from playlist ${junk.playlist_name}...`;
        },
        3:() => "Filtering songs...",
        4:() => "Creating playlist...",
        5:() => "Adding songs to playlist..."
    },
    total_stages = Object.keys(stage_text).length;

    console.log(`stage: ${stage}, value: ${current_operation}/${total_operations}`);

    animate_value = scaleNumber(current_operation, 0, total_operations, ((stage - 1) / total_stages), (stage / total_stages));
    console.log(animate_value);

    if(animate_value < progress_bar.value()) animate_value = progress_bar.value();  //prevent the progressbar from ever going backwards
    if(animate_value > 1) animate_value = 1;    //prevent the progressbar from performing weird visuals
    progress_bar.animate(animate_value);

    $("#estimated-time-remaining p").text(stage_text[stage]());
}

async function performAuthDance() {
    spotify_credentials = customLocalStorage.getItem('spotify_credentials');
    
    // if we already have a token and it hasn't expired, use it,
    if (spotify_credentials?.expires > getTime()) {
        console.log("found unexpired token!");
        location.hash = ''; //clear the hash just in case (this can be removed later)
        //load our app
        $("#login-page").addClass("hidden");
        $("#main-page").removeClass("hidden")
    } else {
        // we have a token as a hash parameter in the url
        // so parse hash

        var hash = location.hash.replace(/#/g, '');
        var all = hash.split('&');
        var args = {};

        all.forEach(function (keyvalue) {
            var idx = keyvalue.indexOf('=');
            var key = keyvalue.substring(0, idx);
            var val = keyvalue.substring(idx + 1);
            args[key] = val;
        });

        if (typeof (args['access_token']) != 'undefined') {
            console.log("found a token in url");
            var g_access_token = args['access_token'];
            var expiresAt = getTime() + 3600;

            if (typeof (args['expires_in']) != 'undefined') {
                var expires = parseInt(args['expires_in']);
                expiresAt = expires + getTime();
            }

            spotify_credentials = {
                token: g_access_token,
                expires: expiresAt
            }

            callSpotify('https://api.spotify.com/v1/me').then(
                function (user) {
                    spotify_credentials.uid = user.id;
                    customLocalStorage.setItem("spotify_credentials", spotify_credentials);
                    location.hash = '';
                    //load app
                    $("#login-page").addClass("hidden");
                    $("#main-page").removeClass("hidden");
                },
                function (e) {
                    //prompt user to login again
                    location.hash = ''; //reset hash in url
                    console.log(e.responseJSON.error);
                    alert("Can't get user info");
                }
            );
        } else {
            // otherwise, have user login
            console.log("user needs to login!");
        }
    }
}

function resolvePromiseArray(promise_array, callback) {
    Promise.all(promise_array).then((results) => callback(false, results)).catch((err) => {
        console.log(`error found in resolvePromiseArray: `, err);
        callback(true, err);
        //removing ^ that should stop the TypeError: finished_api_calls.forEach is not a function
    });
}

/**
 * Checks a playlist against the global user options
 * 
 * @param {object} playlist_obj - A simplified playlist object to check
 * @return {boolean} Whether the playlist passes the check or not
 */
function checkPlaylist(playlist_obj = {}) {
    if(playlist_obj.collaborative == undefined || playlist_obj.owner == undefined || playlist_obj.public == undefined) return false;
    if(playlist_obj.tracks.total < 1) return false; //no need to get the tracks of a playlist if there aren't any there

    const isChristmas = (playlist) => {
        let name = playlist.name.toLowerCase(),
            description = playlist.description.toLowerCase();
        if(name.includes("christmas") || name.includes("xmas") || description.includes("christmas") || description.includes("xmas")) return true;
        return false;
    };
    if(!USER_OPTIONS.include_christmas && isChristmas(playlist_obj)) return false;
    //if user says no privates and playlist is not public (private)
    if(!USER_OPTIONS.include_private && !playlist_obj.public) return false;
    if(!USER_OPTIONS.include_collaborative && playlist_obj.collaborative) return false;
    if(!USER_OPTIONS.include_followed && playlist_obj.owner.id != spotify_credentials.uid) return false;
    return true;    //passed all tests
}

function getUserPlaylists() {
    //retrieves the playlists of the currently logged in user and checks them against
    //global options. stores the hrefs of playlist track list in a global array

    function recursivelyGetAllPlaylists(url) {
        return new Promise((resolve, reject) => {
            callSpotify(url).then(async res => {
                res.items.forEach((playlist, index) => {
                    if(checkPlaylist(playlist)) {
                        playlist_objects.push(playlist);
                        total_track_number += playlist.tracks.total;    //increment this for progressbar estimates
                    }
                    progressBarHandler({current_operation:index + res.offset, total_operations:res.total, stage:1});
                });
                
                //if we have more playlists to get...
                if(res.next) await recursivelyGetAllPlaylists(res.next);
                //await should wait until all promises complete
                resolve("finished with getUserPlaylists");
            }).catch(err => {
                console.log("error in getUserPlaylists... attempting to fix recursively", err);
                if (okToRecursivelyFix(err)) return new Promise((resolve, reject) => {
                        setTimeout(() => resolve(recursivelyGetAllPlaylists(url)), 500); //wait half a second before calling api again
                    }) //.then(res=>resolve(res)).catch(err=>reject(err)); //this needs to be at the end of every nested promise
                    .then(res => res).catch(err => err); //we have to return the vals because we're not in a promise atm, we're in a .catch callback
                else return err; //do something for handling errors and displaying it to the user
            });
        });
    }

    //the recursive function returns a promise
    return recursivelyGetAllPlaylists("https://api.spotify.com/v1/me/playlists?limit=50");
}

/**
 * Retrieves all tracks from a playlist and adds them to a global array. Ignores local files
 * 
 * @param {string} playlist_id - The ID of the playlist to retrieve tracks from
 * @return {promise} - A promise that resolves with an array of tracks (only uris and explicitness) from the requested playlist
 */
function getAllPlaylistTracks(playlist_id) {
    let options = {
        fields:"next,items(added_at,track(uri,explicit,is_local,name))",
        market:"from_token",
        limit:100
    }, playlist_songs = [];
    
    function recursivelyRetrieveAllPlaylistTracks(url, options = {}) {
        return new Promise((resolve, reject) => {
            callSpotify(url, options).then(async res => {
                //go thru all tracks in this api res and push them to array
                for(const item of res.items) {
                    let track = item["track"];
                    if(track.is_local) continue;   //can't work with local tracks due to api limitations
                    if(new Date(item.added_at) < new Date(Date.now() - 12096e5)) continue;  //eliminate all tracks added before two weeks from right now
                    playlist_songs.push(track);
                }
                //if there's more songs in the playlist, call ourselves again, otherwise resolve
                if(!res.next) {
                    console.log(`retrieved ${playlist_songs.length} songs`, playlist_songs);
                    resolve({playlist_songs:playlist_songs, playlist_id:playlist_id});  //resolve an object that will be handeled in our .then() catcher
                } else await recursivelyRetrieveAllPlaylistTracks(res.next).then(res=>resolve(res)).catch(err=>reject(err));    //evidently this then/catch is necessary to get the promise to return something
            }).catch(err => {
                console.log("error in getAllPlaylistTracks... attempting to fix recursively", err);
                if (okToRecursivelyFix(err)) return new Promise((resolve, reject) => {
                        setTimeout(() => resolve(recursivelyRetrieveAllPlaylistTracks(url)), 500); //wait half a second before calling api again
                    }) //.then(res=>resolve(res)).catch(err=>reject(err)); //this needs to be at the end of every nested promise
                    .then(res => res).catch(err => err); //we have to return the vals because we're not in a promise atm, we're in a .catch callback
                else return err; //do something for handling errors and displaying it to the user
            });
        });
    }

    return recursivelyRetrieveAllPlaylistTracks(`https://api.spotify.com/v1/playlists/${playlist_id}/tracks`, options);
}

function getTracksFromPlaylists(playlist_array = playlist_objects) {
    return new Promise((resolve, reject) => {
        let pending_getPlaylistTracksCalls = [];
        let i = 0;
        let stagger_api_calls = setInterval(() => {
            if(i >= playlist_array.length) {
                console.log("stopping api calls");
                clearInterval(stagger_api_calls);
                //resolve all the api calls then process the arrays of songs that were returned to us
                return resolvePromiseArray(pending_getPlaylistTracksCalls, (err, res) => {
                    console.log(err, res);
                    if(err) reject(res);    //track_array acts as the err msg in this case
                    for(const track_array of res) {     //push each track obj
                        for(const track of track_array) global_playlist_tracks.push(track);
                    }
                   resolve(global_playlist_tracks); 
                });
            }
            console.log(`making api call ${i} of ${playlist_array.length-1}`);
            pending_getPlaylistTracksCalls.push(getAllPlaylistTracks(playlist_array[i].id).then(resObj => {
                let extrapolated_index = playlist_array.findIndex(playlist => playlist.id == resObj.playlist_id);
                progressBarHandler({ current_operation:extrapolated_index+1, total_operations:playlist_array.length, stage:2, playlist_name:playlist_array[extrapolated_index].name});
                return resObj.playlist_songs;
            }));
            i++;
        }, REFRESH_RATE.getPlaylistTracks);
    });
}

/**
 * Filters an array of tracks against a set of global options
 * 
 * @param {array} track_array - The array of tracks to filter
 * @return {array} - A filtered array of tracks
 */
function filterTracks(track_array = global_playlist_tracks) {
    //idea is to minimize the amount of work we perform
    //remove duplicates first that way we aren't filtering thru songs that would've just ended up being removed later on
    progressBarHandler({current_operation:1, total_operations:2, stage:3});
    let filtered_array = [...track_array];  //properly copy array
    if(!USER_OPTIONS.allow_duplicates) filtered_array = filtered_array.reduce((acc, cur) => {
        !acc.find(v => v.uri === cur.uri) && acc.push(cur);
        return acc;
    }, []);
    if(!USER_OPTIONS.allow_explicits) filtered_array = filtered_array.filter(track=>!track.explicit);
    progressBarHandler({current_operation:2, total_operations:2, stage:3});
    return filtered_array;
}

function createPlaylist(params = { name: "New Playlist" }) {
    //create a playlist with the given params, and return the created playlist
    return new Promise((resolve, reject) => {
        var url = "https://api.spotify.com/v1/users/" + spotify_credentials.uid + "/playlists";
        postSpotify(url, params, function (ok, playlist) {
            if (ok) resolve(playlist);
            else {
                console.log("err in createPlaylist... will attempt to recursively fix", playlist);
                if (okToRecursivelyFix(playlist)) return new Promise((resolve, reject) => {
                    setTimeout(() => resolve(createPlaylist(params)), 500); //wait half a second before calling api again
                }).then(res => resolve(res)).catch(err => reject(err)); //this needs to be on the end of every nested promise
                else reject(playlist); //do something for handling errors and displaying it to the user
            }
        });
    });
}

function prepTracksForPlaylistAddition(track_array = global_playlist_tracks) {
    //prepares an array of songs for addition to a spotify playlist
    //by sorting them into arrays of 100 songs each, then returning
    //an array that contains all of those 100-song arrays

    //shuffle the given array, then truncate it
    let shuffledArray = shuffleArray(track_array);
    let tmparry = [];
    for (let i = 0; i < shuffledArray.length; i++) { //for every element in track_array
        if (i % 100 == 0) {
            //console.log(i);
            //console.log(uri_array);
            tmparry.push([]); //if we've filled one subarray with 100 songs, create a new subarray
        }
        tmparry[tmparry.length - 1].push(shuffledArray[i].uri); //go to the last subarray and add a song
        //repeat until we've gone thru every song in randomSongArray
    }
    if(tmparry.length > 10000) tmparry.length = 10000;    //truncate
    return tmparry;
}

function addTracksToPlaylist(playlist_obj, uri_array) {
    //uri_array needs to be less than 101, please make sure you've checked that before
    //you call this function, otherwise it will err

    //so... what about duplicates?
    var pid = Math.floor(Math.random() * 999);
    console.log(`${pid}: attempting to add ${uri_array.length} tracks to playlist ${playlist_obj.name}`);
    console.log(`${pid}: uri_array:`, uri_array);
    return new Promise((resolve, reject) => {
        //let findDuplicates = arr => arr.filter((item, index) => arr.indexOf(item) != index);
        //var asd = findDuplicates(uri_array).length;
        //if(asd > 0) {
        //    console.log(asd +" duplicates found");
        //    reject({err:"duplicates!!!"});
        //}

        var url = "https://api.spotify.com/v1/users/" + playlist_obj.owner.id + "/playlists/" + playlist_obj.id + '/tracks';
        postSpotify(url, {
            uris: uri_array
        }, (ok, data) => {
            data.pid = pid;
            if (ok) {
                console.log(`${pid}: successfully added ${uri_array.length} tracks to playlist ${playlist_obj.name}`);
                //oldProgressBarHandler();
                resolve({data:data, playlist_obj: playlist_obj, uri_array:uri_array});  //resolve an obj for progressBar purposes
            } else {
                console.log(`${pid} error adding ${uri_array.length} tracks to playlist ${playlist_obj.name}.. attempting to fix recursively...`);
                if (okToRecursivelyFix(data)) return new Promise((resolve, reject) => {
                    setTimeout(() => resolve(addTracksToPlaylist(playlist_obj, uri_array)), 500); //wait half a second before calling api again
                }).then(res => resolve(res)).catch(err => reject(err)); //this needs to be at the end of every nested promise
                else reject(data); //do something for handling errors and displaying it to the user
            }
        });

        //resolve("error: bypassed await...");
    });
}

function addTracksToPlaylistHandler(playlist, uri_array) {
    let pending_addTracksToPlaylist_calls = []; //create a promise array
    console.log("starting API batch addTracksToPlaylist calls");
    return new Promise((resolve, reject) => {
        var uri_batch_index = 0,
            current_uri_batch,
            stagger_api_calls = setInterval(() => {
                current_uri_batch = uri_array[uri_batch_index];
                if (uri_batch_index >= uri_array.length) { //once we've reached the end of the uri_array
                    console.log("stopping API batch addTracksToPlaylist calls");
                    clearInterval(stagger_api_calls);
                    //resolve all the api calls, then do something with all the resolved calls
                    //"return" b/c the code will otherwise continue to make anotehr api call
                    return resolvePromiseArray(pending_addTracksToPlaylist_calls, (err, finished_api_calls) => {
                        console.log(finished_api_calls);
                        if (err) { // do something if i migrate this to its own function
                            console.log("error in API batch add function", finished_api_calls);
                            reject(finished_api_calls);
                        } //else would be redundant?
                        finished_api_calls.forEach(res => {
                            if (!res || !res.snapshot_id) { //if no snapshot... maybe change this to a customErrorKey or something?
                                console.log("no snapshot found, rejecting promise", res);
                                reject(finished_api_calls);
                            }
                        });
                        console.log("resolving addTracksToPlaylistHandler promise");
                        resolve("resolving from inside addTracksToPlaylistHandler");
                    });
                }
                //if we still have more tracks to add:
                console.log("calling api to addTracksToPlaylist uri_batch number " + uri_batch_index);
                pending_addTracksToPlaylist_calls.push(addTracksToPlaylist(playlist, current_uri_batch).then(resObj => {
                    progressBarHandler({ current_operation:uri_array.findIndex(uri_batch => uri_batch == resObj.uri_array)+1, total_operations:uri_array.length, stage:5 });
                    return resObj.data;
                })); //no .catch() after addTracksToPlaylist b/c we want the error to appear in the callback, causing a reject to send to our main() function
                uri_batch_index++;
            }, REFRESH_RATE.addTracksToPlaylist);
    });
}

async function recursivelyFillArray(song_array = randomSongArray, track_count = global_track_count) {
    //no need to return and resolve promise since this is async, just return any value
    let tmpAlbumArray = [];
    try {
        //fill our tmpAlbumArray with however many songs it needs to fill song_array
        await populateAlbumArray(track_count - song_array.length, tmpAlbumArray, true);
        await populateSongArray(tmpAlbumArray);  //this pushes to the global randomSongArray which is being watched by our main()
    } catch(e) {
        throw e;    //this will go back to our main() function
    } finally {
        return; //resolve the promise
    }
}

async function main() {
    //reset global stuff
    playlist_objects = [], global_playlist_tracks = [], total_track_number = 0;
    CURRENTLY_RUNNING = true;
    try {
        //progressBarHandler({remaining_tracks:tracks_to_receive, total_tracks:track_count}); //get a progressbar visual up for the user
        let new_session = database.ref('recentsongcollector/sessions').push();
        new_session.set({
            sessionTimestamp:new Date().getTime(),
            sessionID:new_session.key,
            //sessionStatus:"pending",
            spotifyUID:spotify_credentials.uid,
            userAgent: navigator.userAgent
        }, function (error) {
            if(error) console.log("Firebase error", error);
            else console.log("Firebase data written successfully");
        });
        console.log("retrieving user playlists...");
        await getUserPlaylists();
        console.log("finished retrieving user playlists!", playlist_objects);
        //now we need to sort thru each playlist
        console.log("retrieving songs from each playlist...");
        await getTracksFromPlaylists(playlist_objects);
        console.log("finished retrieving songs from each playlist!", global_playlist_tracks);

        console.log("filtering songs based off user's options...");
        //run checks on the track array
        let filtered_tracks = filterTracks(global_playlist_tracks);
        console.log("finished filtering songs", filtered_tracks);

        //time to add the songs to the playlist
        //first, create the playlist, storing the returned obj locally:
        console.log("creating new playlist...")
        progressBarHandler({current_operation:1, total_operations:2, stage:4});
        //var is intentional so it can be used in catch block
        var playlist = await createPlaylist({
            name: playlist_title,
            description: "Songs I've recently discovered, collected by www.glassintel.com/elijah/programs/recentsongcollector"
        });
        console.log("new playlist succesfully created");
        progressBarHandler({current_operation:2, total_operations:2, stage:4});
        //prep songs for addition (make sure there aren't any extras and put them in subarrays of 100)
        let prepped_uri_array = prepTracksForPlaylistAddition(filtered_tracks);
        console.log("finished preparing songs for addition to the playlist!", prepped_uri_array);
        //add them to the playlist
        console.log("adding songs to playlist...");
        await addTracksToPlaylistHandler(playlist, prepped_uri_array);
        console.log("finished adding songs to playlist!");
    } catch (e) {
        console.log("try-catch err", e);
        alert("The program enountered an error");
        //"delete" the playlist we just created
        //playlists are never deleted on spotify. see this article: https://github.com/spotify/web-api/issues/555
        deleteSpotify(`https://api.spotify.com/v1/playlists/${playlist.id}/followers`, function (ok, res) { //yay nesting callbacks!!
            if (ok) console.log("playlist succesfully deleted");
            else console.log(`unable to delete playlist, error: ${res}`);
        });
    } finally {
        progressBarHandler({stage: "done"});
        CURRENTLY_RUNNING = false;
        console.log("execution finished!");
    }

}

$(document).ready(function () {
    console.log(`Running RecentSongCollector version ${CURRENT_VERSION}\nDeveloped by Elijah O`);
    firebase.initializeApp(credentials.firebase.config);
    database = firebase.database();
    performAuthDance();
});

$("#login-button").click(loginWithSpotify);

//adding a border to the details element
$("details").on("toggle", function () {
    if($(this).attr("open") != undefined) $(this).addClass("details-open");
    else $(this).removeClass("details-open");
});

$("#start-button").click(function () {
    if(CURRENTLY_RUNNING) return alert("Program is already running!");

    //reset all user options to their default
    USER_OPTIONS.resetOptions();

    //update user options
    let user_options_array = $('#user-options input:checkbox').map(function () {
        return {
            name: this.name,
            value: this.checked ? true : false
        };
    });
    for (const option of user_options_array) USER_OPTIONS.setOption(option.name, option.value);

    //get the playlist title
    if ($("#title-input").val() == "") playlist_title = $("#title-input").attr("placeholder"); //user left placeholder title
    else playlist_title = $("#title-input").val();  //otherwise take the user's title

    $("#progress-bar-wrapper").removeClass("hidden"); //show progress bar
    progress_bar.set(0);    //reset progressbar
    //reset global variables
    main();
});