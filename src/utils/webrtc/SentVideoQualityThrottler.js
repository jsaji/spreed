/**
 *
 * @copyright Copyright (c) 2020, Daniel Calviño Sánchez (danxuliu@gmail.com)
 *
 * @license GNU AGPL version 3 or any later version
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

import {
	QUALITY,
	VideoConstrainer,
} from './VideoConstrainer'

/**
 * Helper to adjust the quality of the sent video based on the current call
 * state.
 *
 * The properties of the local video (like resolution or frame rate) can be
 * changed on the fly during a call with immediate effect, without having to
 * reconnect to the call. This class uses that feature to dynamically reduce or
 * increase the video quality depending on the call state. Basically the goal is
 * to reduce the CPU usage when there are too many participants in a call.
 *
 * @param {LocalMediaModel} localMediaModel the model for the local media.
 * @param {CallParticipantCollection} callParticipantCollection the collection
 *        that contains the models for the rest of the participants in the call.
 * @param {Signaling} signaling the signaling object to listen to for control
 *        messages
 */
export default function SentVideoQualityThrottler(localMediaModel, callParticipantCollection, signaling) {
	this._localMediaModel = localMediaModel
	this._callParticipantCollection = callParticipantCollection
	this._signaling = signaling

	this._videoConstrainer = new VideoConstrainer(localMediaModel)

	this._handlers = []

	this._gracePeriodAfterSpeakingTimeout = null
	this._speakingOrInGracePeriodAfterSpeaking = false

	this._availableVideosThreshold = {}
	this._availableVideosThreshold[this.QUALITY.HIGH] = 2
	this._availableVideosThreshold[this.QUALITY.MEDIUM] = 4
	this._availableVideosThreshold[this.QUALITY.LOW] = 7
	this._availableVideosThreshold[this.QUALITY.VERY_LOW] = 10
	this._availableVideosThreshold[this.QUALITY.THUMBNAIL] = 15

	this._availableAudiosThreshold = {}
	this._availableAudiosThreshold[this.QUALITY.HIGH] = 10
	this._availableAudiosThreshold[this.QUALITY.MEDIUM] = 20
	this._availableAudiosThreshold[this.QUALITY.LOW] = 30
	this._availableAudiosThreshold[this.QUALITY.VERY_LOW] = 40
	this._availableAudiosThreshold[this.QUALITY.THUMBNAIL] = 50

	this._handleSignalingMessageBound = this._handleSignalingMessage.bind(this)
	this._handleLocalVideoAvailableChangeBound = this._handleLocalVideoAvailableChange.bind(this)
	this._handleAddParticipantBound = this._handleAddParticipant.bind(this)
	this._handleRemoveParticipantBound = this._handleRemoveParticipant.bind(this)
	this._handleLocalAudioEnabledChangeBound = this._handleLocalAudioEnabledChange.bind(this)
	this._handleLocalSpeakingChangeBound = this._handleLocalSpeakingChange.bind(this)
	this._adjustVideoQualityIfNeededBound = this._adjustVideoQualityIfNeeded.bind(this)

	this._signaling.on('message', this._handleSignalingMessageBound)
	this._localMediaModel.on('change:videoAvailable', this._handleLocalVideoAvailableChangeBound)

	if (this._localMediaModel.get('videoAvailable')) {
		this._startListeningToChanges()
	}
}
SentVideoQualityThrottler.prototype = {

	QUALITY: QUALITY,

	on: function(event, handler) {
		if (!this._handlers.hasOwnProperty(event)) {
			this._handlers[event] = [handler]
		} else {
			this._handlers[event].push(handler)
		}
	},

	off: function(event, handler) {
		const handlers = this._handlers[event]
		if (!handlers) {
			return
		}

		const index = handlers.indexOf(handler)
		if (index !== -1) {
			handlers.splice(index, 1)
		}
	},

	_trigger: function(event, args) {
		let handlers = this._handlers[event]
		if (!handlers) {
			return
		}

		if (!args) {
			args = []
		}

		args.unshift(this)

		handlers = handlers.slice(0)
		for (let i = 0; i < handlers.length; i++) {
			const handler = handlers[i]
			handler.apply(handler, args)
		}
	},

	setAvailableVideosThreshold: function(availableVideosThreshold) {
		this._validateThreshold(availableVideosThreshold)

		this._availableVideosThreshold = availableVideosThreshold

		this._trigger('change:availableVideosThreshold', [availableVideosThreshold])

		this._adjustVideoQualityIfNeeded()
	},

	setAvailableAudiosThreshold: function(availableAudiosThreshold) {
		this._validateThreshold(availableAudiosThreshold)

		this._availableAudiosThreshold = availableAudiosThreshold

		this._trigger('change:availableAudiosThreshold', [availableAudiosThreshold])

		this._adjustVideoQualityIfNeeded()
	},

	_validateThreshold: function(threshold) {
		for (let i = this.QUALITY.THUMBNAIL; i <= this.QUALITY.HIGH; i++) {
			if (!(i in threshold)) {
				throw new Error('No threshold for quality ' + i)
			}

			if (i > this.QUALITY.THUMBNAIL && threshold[i] > threshold[i - 1]) {
				console.warn('Threshold for quality ' + i + ' (' + threshold[i] + ') > threshold for quality ' + (i - 1) + ' (' + threshold[i - 1] + '), it will be ignored')
			}
		}
	},

	destroy: function() {
		this._localMediaModel.off('change:videoAvailable', this._handleLocalVideoAvailableChangeBound)

		this._stopListeningToChanges()
	},

	_handleSignalingMessage: function(message) {
		if (message.type !== 'control') {
			return
		}

		if (message.payload.action === 'forceAvailableVideosThreshold') {
			console.debug('Available videos threshold changed by a moderator', message.payload.threshold)
			this.setAvailableVideosThreshold(message.payload.threshold)
		} else if (message.payload.action === 'forceAvailableAudiosThreshold') {
			console.debug('Available audios threshold changed by a moderator', message.payload.threshold)
			this.setAvailableAudiosThreshold(message.payload.threshold)
		}
	},

	_handleLocalVideoAvailableChange: function(localMediaModel, videoAvailable) {
		if (videoAvailable) {
			this._startListeningToChanges()
		} else {
			this._stopListeningToChanges()
		}
	},

	_startListeningToChanges: function() {
		this._localMediaModel.on('change:videoEnabled', this._adjustVideoQualityIfNeededBound)
		this._localMediaModel.on('change:audioEnabled', this._handleLocalAudioEnabledChangeBound)
		this._localMediaModel.on('change:speaking', this._handleLocalSpeakingChangeBound)

		this._callParticipantCollection.on('add', this._handleAddParticipantBound)
		this._callParticipantCollection.on('remove', this._handleRemoveParticipantBound)

		this._callParticipantCollection.callParticipantModels.forEach(callParticipantModel => {
			callParticipantModel.on('change:videoAvailable', this._adjustVideoQualityIfNeededBound)
		})

		this._handleLocalSpeakingChange()
		this._handleLocalAudioEnabledChange()

		this._adjustVideoQualityIfNeeded()
	},

	_stopListeningToChanges: function() {
		this._localMediaModel.off('change:videoEnabled', this._adjustVideoQualityIfNeededBound)
		this._localMediaModel.off('change:audioEnabled', this._handleLocalAudioEnabledChangeBound)
		this._localMediaModel.off('change:speaking', this._handleLocalSpeakingChangeBound)

		this._callParticipantCollection.off('add', this._handleAddParticipantBound)
		this._callParticipantCollection.off('remove', this._handleRemoveParticipantBound)

		this._callParticipantCollection.callParticipantModels.forEach(callParticipantModel => {
			callParticipantModel.off('change:videoAvailable', this._adjustVideoQualityIfNeededBound)
		})
	},

	_handleAddParticipant: function(callParticipantCollection, callParticipantModel) {
		callParticipantModel.on('change:videoAvailable', this._adjustVideoQualityIfNeededBound)

		this._adjustVideoQualityIfNeeded()
	},

	_handleRemoveParticipant: function(callParticipantCollection, callParticipantModel) {
		callParticipantModel.off('change:videoAvailable', this._adjustVideoQualityIfNeededBound)

		this._adjustVideoQualityIfNeeded()
	},

	_handleLocalAudioEnabledChange: function() {
		if (this._localMediaModel.get('audioEnabled')) {
			return
		}

		window.clearTimeout(this._gracePeriodAfterSpeakingTimeout)
		this._gracePeriodAfterSpeakingTimeout = null

		this._speakingOrInGracePeriodAfterSpeaking = false

		this._adjustVideoQualityIfNeeded()
	},

	_handleLocalSpeakingChange: function() {
		if (this._localMediaModel.get('speaking')) {
			window.clearTimeout(this._gracePeriodAfterSpeakingTimeout)
			this._gracePeriodAfterSpeakingTimeout = null

			this._speakingOrInGracePeriodAfterSpeaking = true

			this._adjustVideoQualityIfNeeded()

			return
		}

		this._gracePeriodAfterSpeakingTimeout = window.setTimeout(() => {
			this._speakingOrInGracePeriodAfterSpeaking = false

			this._adjustVideoQualityIfNeeded()
		}, 5000)
	},

	_adjustVideoQualityIfNeeded: function() {
		if (!this._localMediaModel.get('videoAvailable') || !this._localMediaModel.get('videoEnabled')) {
			return
		}

		const quality = this._getQualityForState()
		this._videoConstrainer.applyConstraints(quality)
	},

	_getQualityForState: function() {
		if (this._speakingOrInGracePeriodAfterSpeaking) {
			return this.QUALITY.HIGH
		}

		let availableVideosCount = 0
		let availableAudiosCount = 0
		this._callParticipantCollection.callParticipantModels.forEach(callParticipantModel => {
			if (callParticipantModel.get('videoAvailable')) {
				availableVideosCount++
			}
			if (callParticipantModel.get('audioAvailable')) {
				availableAudiosCount++
			}
		})

		for (let i = this.QUALITY.THUMBNAIL; i < this.QUALITY.HIGH; i++) {
			if (availableVideosCount >= this._availableVideosThreshold[i]
				|| availableAudiosCount >= this._availableAudiosThreshold[i]) {
				return i
			}
		}

		return this.QUALITY.HIGH
	},

}
