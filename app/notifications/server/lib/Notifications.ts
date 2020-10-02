import { Meteor } from 'meteor/meteor';
import { Promise } from 'meteor/promise';
import { DDPCommon } from 'meteor/ddp-common';

import { Subscriptions, Rooms } from '../../../models/server';
import { NotificationsModule } from '../../../../server/modules/notifications/notifications.module';
import { Streamer, IPublication, DDPSubscription, StreamerCentral } from '../../../../server/modules/streamer/streamer.module';
import { ISubscription } from '../../../../definition/ISubscription';
import { api } from '../../../../server/sdk/api';
import {
	Subscriptions as SubscriptionsRaw,
	Rooms as RoomsRaw,
	Users as UsersRaw,
	Settings as SettingsRaw,
} from '../../../models/server/raw';

// TODO: Replace this in favor of the api.broadcast
StreamerCentral.on('broadcast', (name, eventName, args) => {
	api.broadcast('stream', [
		name,
		eventName,
		args,
	]);
});

export class Stream extends Streamer {
	registerPublication(name: string, fn: (eventName: string, options: boolean | {useCollection?: boolean; args?: any}) => void): void {
		Meteor.publish(name, function(eventName, options) {
			return Promise.await(fn.call(this, eventName, options));
		});
	}

	registerMethod(methods: Record<string, (eventName: string, ...args: any[]) => any>): void {
		Meteor.methods(methods);
	}

	changedPayload(collection: string, id: string, fields: Record<string, any>): string | false {
		return DDPCommon.stringifyDDP({
			msg: 'changed',
			collection,
			id,
			fields,
		});
	}
}

class RoomStreamer extends Stream {
	async _publish(publication: IPublication, eventName: string, options: boolean | {useCollection?: boolean; args?: any} = false): Promise<void> {
		await super._publish(publication, eventName, options);
		const { userId } = publication._session;
		if (!userId) {
			return;
		}

		if (/rooms-changed/.test(eventName)) {
			const roomEvent = (...args: any[]): void => {
				const payload = this.changedPayload(this.subscriptionName, 'id', {
					eventName: `${ userId }/rooms-changed`,
					args,
				});

				publication._session.socket?.send(
					payload,
				);
			};

			const subscriptions: Pick<ISubscription, 'rid'>[] = Subscriptions.find(
				{ 'u._id': userId },
				{ fields: { rid: 1 } },
			).fetch();

			subscriptions.forEach(({ rid }) => {
				this.on(rid, roomEvent);
			});

			const userEvent = (clientAction: string, { rid }: Partial<ISubscription> = {}): void => {
				if (!rid) {
					return;
				}

				switch (clientAction) {
					case 'inserted':
						subscriptions.push({ rid });
						this.on(rid, roomEvent);

						// after a subscription is added need to emit the room again
						roomEvent('inserted', Rooms.findOneById(rid));
						break;

					case 'removed':
						this.removeListener(rid, roomEvent);
						break;
				}
			};
			this.on(userId, userEvent);

			publication.onStop(() => {
				this.removeListener(userId, userEvent);
				subscriptions.forEach(({ rid }) => this.removeListener(rid, roomEvent));
			});
		}
	}
}

class MessageStream extends Stream {
	getSubscriptionByUserIdAndRoomId(userId: string, rid: string): DDPSubscription | undefined {
		return [...this.subscriptions].find((sub) => sub.eventName === rid && sub.subscription.userId === userId);
	}

	async _publish(publication: IPublication, eventName: string, options: boolean | {useCollection?: boolean; args?: any} = false): Promise<void> {
		await super._publish(publication, eventName, options);
		const { userId } = publication._session;
		if (!userId) {
			return;
		}

		const userEvent = (clientAction: string, { rid }: {rid: string}): void => {
			switch (clientAction) {
				case 'removed':
					this.removeListener(userId, userEvent);
					const sub = this.getSubscriptionByUserIdAndRoomId(userId, rid);
					sub && this.removeSubscription(sub, eventName);
					break;
			}
		};
		this.on(userId, userEvent);
	}

	mymessage(eventName: string, args: any[]): void {
		const subscriptions = this.subscriptionsByEventName.get(eventName);
		if (!Array.isArray(subscriptions)) {
			return;
		}
		subscriptions.forEach(async ({ subscription }) => {
			// TODO: bring back the options
			const options = await this.isEmitAllowed(subscription, eventName, args);
			if (options) {
				subscription._session.socket?.send(this.changedPayload(this.subscriptionName, 'id', {
					eventName,
					args: [args, options],
				}));
			}
		});
	}
}

const notifications = new NotificationsModule(Stream, RoomStreamer, MessageStream);

notifications.configure({
	Rooms: RoomsRaw,
	Subscriptions: SubscriptionsRaw,
	Users: UsersRaw,
	Settings: SettingsRaw,
});

export default notifications;